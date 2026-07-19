import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';

import type { AppServerProtocolProfileId } from './app-server-protocol-registry';

export interface CodexBinaryArtifact {
  readonly binaryName: string;
  readonly binarySha256: string;
}

/** Evidence for one executable artifact; it never participates in protocol selection. */
export interface CodexRuntimeArtifact extends CodexBinaryArtifact {
  readonly protocolContractId: AppServerProtocolProfileId;
}

export async function captureCodexBinaryArtifact(
  binaryPath: string,
): Promise<CodexBinaryArtifact> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(binaryPath);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', resolve);
  });
  return Object.freeze({
    binaryName: basename(binaryPath),
    binarySha256: hash.digest('hex'),
  });
}

export async function captureCodexRuntimeArtifact(
  binaryPath: string,
  protocolContractId: AppServerProtocolProfileId,
): Promise<CodexRuntimeArtifact> {
  const binary = await captureCodexBinaryArtifact(binaryPath);
  return Object.freeze({ ...binary, protocolContractId });
}
