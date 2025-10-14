// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stack } from "aws-cdk-lib";
import {
  Architecture,
  Code,
  LayerVersion,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { execSync } from "child_process";
import { Construct } from "constructs";
import { existsSync, mkdirSync, moveSync, rmSync } from "fs-extra";
import path from "path";

export class LambdaLayers extends Construct {
  readonly commonLayerVersion: LayerVersion;
  readonly dependencyLayerVersion: LayerVersion;
  readonly rolesAnywhereHelperLayer: LayerVersion;
  readonly layers: LayerVersion[];
  private static instances: { [key: string]: LambdaLayers } = {};

  private constructor(scope: Construct, id: string) {
    super(scope, id);

    this.commonLayerVersion = new NodejsLayerVersion(
      this,
      "CommonLayerVersion",
      {
        path: path.join(__dirname, "..", "..", "..", "layers", "common"),
        description: "Common lib for Innovation Sandbox on AWS",
      },
    );

    this.dependencyLayerVersion = new NodejsLayerVersion(
      this,
      "DependenciesLayerVersion",
      {
        path: path.join(__dirname, "..", "..", "..", "layers", "dependencies"),
        description:
          "Third party runtime dependencies for Innovation Sandbox on AWS",
      },
    );

    // IAM Roles Anywhere credential helper layer
    this.rolesAnywhereHelperLayer = new LayerVersion(
      this,
      "RolesAnywhereHelperLayer",
      {
        code: Code.fromAsset(
          path.join(__dirname, "..", "..", "..", "layers", "roles-anywhere-helper"),
        ),
        description: "AWS IAM Roles Anywhere credential helper for certificate-based authentication",
        compatibleRuntimes: [Runtime.NODEJS_22_X],
        compatibleArchitectures: [Architecture.ARM_64],
      },
    );

    this.layers = [this.dependencyLayerVersion, this.commonLayerVersion];
  }

  public static get(
    scope: Construct,
    layerId: string | undefined = undefined,
  ): LambdaLayers {
    const currentId = layerId ?? Stack.of(scope).stackName;
    if (!LambdaLayers.instances[currentId]) {
      LambdaLayers.instances[currentId] = new LambdaLayers(
        scope,
        `ISB-Lambda-Layer-${currentId}`,
      );
    }
    return LambdaLayers.instances[currentId]!;
  }
}

interface NodejsLayerVersionProps {
  path: string;
  description: string;
}

/**
 * Helper function to remove directory with retry logic for Windows compatibility
 * @param dirPath - Directory path to remove (validated to prevent command injection)
 */
function removeDirectoryWithRetry(dirPath: string, maxRetries = 5): void {
  // Validate dirPath to ensure it's a safe filesystem path (no shell metacharacters)
  // This path comes from hardcoded __dirname + relative paths, but validate for defense in depth
  if (!path.isAbsolute(dirPath)) {
    dirPath = path.resolve(dirPath);
  }
  // Ensure path contains no shell injection characters
  if (dirPath.includes(';') || dirPath.includes('&') || dirPath.includes('|') || dirPath.includes('`')) {
    throw new Error(`Invalid directory path contains shell metacharacters: ${dirPath}`);
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      rmSync(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error: any) {
      if (attempt === maxRetries - 1) {
        // Last attempt - try using system commands as fallback
        // semgrep: ignore detect-child-process - dirPath is validated above and comes from hardcoded __dirname paths during CDK synthesis
        try {
          if (process.platform === "win32") {
            execSync(`rmdir /s /q "${dirPath}"`, { stdio: "ignore" });
          } else {
            execSync(`rm -rf "${dirPath}"`, { stdio: "ignore" });
          }
          return;
        } catch (fallbackError) {
          throw new Error(
            `Failed to remove directory ${dirPath} after ${maxRetries} attempts: ${error.message}`
          );
        }
      }
      // Wait before retrying (exponential backoff)
      const delay = 100 * Math.pow(2, attempt);
      execSync(`node -e "setTimeout(() => {}, ${delay})"`);
    }
  }
}

/**
 * Helper function to move directory with retry logic for Windows compatibility
 * @param srcPath - Source directory path (validated to prevent command injection)
 * @param destPath - Destination directory path (validated to prevent command injection)
 */
function moveDirectoryWithRetry(srcPath: string, destPath: string, maxRetries = 5): void {
  // Validate paths to ensure they're safe filesystem paths (no shell metacharacters)
  // These paths come from hardcoded __dirname + relative paths, but validate for defense in depth
  const validatePath = (p: string) => {
    let absPath = p;
    if (!path.isAbsolute(p)) {
      absPath = path.resolve(p);
    }
    if (absPath.includes(';') || absPath.includes('&') || absPath.includes('|') || absPath.includes('`')) {
      throw new Error(`Invalid path contains shell metacharacters: ${absPath}`);
    }
    return absPath;
  };

  const absSrcPath = validatePath(srcPath);
  const absDestPath = validatePath(destPath);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      moveSync(absSrcPath, absDestPath);
      return;
    } catch (error: any) {
      if (attempt === maxRetries - 1) {
        // Last attempt - try using system commands as fallback
        // semgrep: ignore detect-child-process - paths are validated above and come from hardcoded __dirname paths during CDK synthesis
        try {
          if (process.platform === "win32") {
            execSync(`move /Y "${absSrcPath}" "${absDestPath}"`, { stdio: "ignore" });
          } else {
            execSync(`mv "${absSrcPath}" "${absDestPath}"`, { stdio: "ignore" });
          }
          return;
        } catch (fallbackError) {
          throw new Error(
            `Failed to move directory from ${absSrcPath} to ${absDestPath} after ${maxRetries} attempts: ${error.message}`
          );
        }
      }
      // Wait before retrying (exponential backoff)
      const delay = 100 * Math.pow(2, attempt);
      execSync(`node -e "setTimeout(() => {}, ${delay})"`);
    }
  }
}

class NodejsLayerVersion extends LayerVersion {
  constructor(scope: Construct, id: string, props: NodejsLayerVersionProps) {
    //prettier-ignore
    execSync("npm install --workspaces=false --install-links", { // NOSONAR typescript:S4036 - only used in cdk synth process
      cwd: props.path,
    });

    // Clean up dist directory with retry logic for Windows compatibility
    const distPath = path.join(props.path, "dist");
    if (existsSync(distPath)) {
      removeDirectoryWithRetry(distPath);
    }

    mkdirSync(path.join(props.path, "dist/nodejs"), { recursive: true });
    moveDirectoryWithRetry(
      path.join(props.path, "node_modules"),
      path.join(props.path, "dist/nodejs/node_modules"),
    );
    super(scope, id, {
      code: Code.fromAsset(path.join(props.path, "dist")),
      description: props.description,
      compatibleRuntimes: [Runtime.NODEJS_22_X],
      compatibleArchitectures: [Architecture.ARM_64],
    });
  }
}
