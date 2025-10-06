// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  Profile,
  SamlConfig,
  Strategy as SamlStrategy,
  VerifiedCallback,
} from "@node-saml/passport-saml";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import express, { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import passport from "passport";

import {
  JwtVerificationResult,
  verifyJwt,
} from "@amzn/innovation-sandbox-commons/utils/jwt.js";
import {
  SSOConfig,
  getSSOConfig,
} from "@amzn/innovation-sandbox-sso-handler/config.js";
import { User } from "@amzn/innovation-sandbox-sso-handler/user.js";

const logger = new Logger();

export const app = express();
app.disable("x-powered-by");

app.use(cookieParser());

// CORS configuration will be set dynamically per request
app.use(bodyParser.urlencoded({ extended: true }));

const initServer = (config: SSOConfig) => {
  logger.debug(`initServer with config: ${JSON.stringify(config)}`);
  const samlStrategyConfig: SamlConfig = {
    callbackUrl: `${config.webAppUrl}${config.callBackPathFromRoot}`,
    entryPoint: config.idpSignInUrl,
    issuer: config.idpAudience,
    idpCert: config.idpCert,
  };

  const verifyCallback = (profile: Profile, done: VerifiedCallback) => {
    logger.debug(`verifyCallback: Received profile: ${profile}`);
    done(null, profile);
  };

  //@ts-ignore
  passport.use(new SamlStrategy(samlStrategyConfig, verifyCallback));
  app.use(passport.initialize());
  passport.serializeUser((user, done) => {
    done(null, user);
  });
  passport.deserializeUser((user, done) => {
    done(null, user as Profile);
  });
};

interface APIGatewayContext {
  context: {
    [key: string]: any;
  };
}
interface APIGatewayRequest extends Request {
  apiGateway?: APIGatewayContext;
}

// Handler functions for different paths
const handleLogin = (
  req: APIGatewayRequest,
  res: Response,
  next: NextFunction,
  config: SSOConfig,
) => {
  logger.debug(`GET ${config.loginPath}: Initiating SAML authentication`);
  passport.authenticate("saml", (err: any, user: any) => {
    if (err) {
      logger.error(`Error during authentication: ${err}`);
      return next(err);
    }
    if (!user) {
      logger.error("No user authenticated");
      return res.redirect(config.webAppUrl);
    }
    req.logIn(user, (err) => {
      if (err) {
        logger.error(`Error logging in user: ${err}`);
        return next(err);
      }
      logger.debug(`User authenticated: ${user}`);
    });
  })(req, res, next);
};

const handleLoginStatus = async (
  req: APIGatewayRequest,
  res: Response,
  config: SSOConfig,
) => {
  logger.debug(`GET ${config.loginStatusPath}: Checking login status`);
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(200).json({
      authenticated: false,
      message: "No token provided",
    });
  }

  const jwtVerificationResult: JwtVerificationResult = await verifyJwt(
    config.jwtSecret,
    token,
  );
  logger.debug(
    `jwtVerificationResult: ${JSON.stringify(jwtVerificationResult)}`,
  );

  if (jwtVerificationResult.verified) {
    return res.status(200).json({
      authenticated: true,
      session: jwtVerificationResult.session,
    });
  }

  return res.status(200).json({
    authenticated: false,
    message: jwtVerificationResult.message,
  });
};

const handleLogout = (res: Response, config: SSOConfig) => {
  logger.debug(`GET ${config.logoutPath}: Redirecting to logout`);
  res.redirect(config.idpSignOutUrl);
};

const handleUnauthorized = (req: APIGatewayRequest, res: Response) => {
  logger.error(`GET ${req.url} Unauthorized`);
  res.status(403).json({
    message: "Missing Authentication Token",
  });
};

// this is an express app handling the route /auth/{action+}
// the express router doesn't catch /prod/auth/login or /auth/login separately
app.get(
  "*",
  async (req: APIGatewayRequest, res: Response, next: NextFunction) => {
    const config: SSOConfig = await getSSOConfig(
      req.apiGateway?.context as any,
    );
    initServer(config);
    logger.debug(`GET * for ${req.url}`);

    // Set CORS headers for frontend origin
    res.header("Access-Control-Allow-Origin", config.webAppUrl);
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    const path = req.path.replace(/\/$/, "");

    switch (path) {
      case config.loginPath:
        handleLogin(req, res, next, config);
        break;
      case config.loginStatusPath:
        await handleLoginStatus(req, res, config);
        break;
      case config.logoutPath:
        handleLogout(res, config);
        break;
      default:
        handleUnauthorized(req, res);
        break;
    }
  },
);

// Handler function for login callback
const handleLoginCallback = (
  req: APIGatewayRequest,
  res: Response,
  next: NextFunction,
  config: SSOConfig,
) => {
  logger.debug(`POST ${config.loginCallbackPath}: Handling SAML response`);
  passport.authenticate(
    "saml",
    async (err: Error | null, user: Profile | undefined) => {
      if (err) {
        logger.error(`Authentication failed: ${err.message}`);
        return res
          .status(400)
          .json({ message: "Authentication failed", error: err.message });
      }

      if (!user) {
        logger.error("User not authenticated");
        return res.status(401).json({ message: "User not authenticated" });
      }

      logger.debug(`User authenticated: ${JSON.stringify(user)}`);
      const isbUser = await User.getIsbUser(user.nameID);

      if (!isbUser) {
        logger.error("Unable to retrieve user information");
        return res.status(401).json({ message: "User not authenticated" });
      }

      logger.debug(`IsbUser authenticated: ${JSON.stringify(isbUser)}`);
      const token = jwt.sign({ user: isbUser }, config.jwtSecret, {
        expiresIn: config.sessionDuration,
      });
      res.redirect(`${config.webAppUrl}?token=${token}`);
    },
  )(req, res, next);
};

app.post(
  "*",
  async (req: APIGatewayRequest, res: Response, next: NextFunction) => {
    const config: SSOConfig = await getSSOConfig(
      req.apiGateway?.context as any,
    );
    initServer(config);
    logger.debug(`POST * for ${req.url}`);

    // Set CORS headers for frontend origin
    res.header("Access-Control-Allow-Origin", config.webAppUrl);
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    const path = req.path.replace(/\/$/, "");

    if (path === config.loginCallbackPath) {
      handleLoginCallback(req, res, next, config);
    } else {
      logger.debug("Unauthorized POST");
      res.status(403).json({
        message: "Missing Authentication Token",
      });
    }
  },
);

// Handle OPTIONS preflight requests
app.options(
  "*",
  async (req: APIGatewayRequest, res: Response) => {
    const config: SSOConfig = await getSSOConfig(
      req.apiGateway?.context as any,
    );
    logger.debug(`OPTIONS * for ${req.url}`);

    // Set CORS headers for frontend origin
    res.header("Access-Control-Allow-Origin", config.webAppUrl);
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.status(200).send();
  },
);
