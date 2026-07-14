import { MacosPlatformAdapter } from './macos-platform-adapter';
import {
  DesktopIpcEndpointError,
  type PlatformAdapter,
  type PlatformAdapterFactoryOptions,
} from './platform-adapter';
import { WindowsPlatformAdapter } from './windows-platform-adapter';

/** Creates the platform-specific Desktop IPC boundary for this runtime. */
export function createPlatformAdapter(
  options: PlatformAdapterFactoryOptions = {},
): PlatformAdapter {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    return new MacosPlatformAdapter();
  }
  if (platform === 'win32') {
    return new WindowsPlatformAdapter();
  }
  throw new DesktopIpcEndpointError(
    'DESKTOP_IPC_UNSUPPORTED_PLATFORM',
    `Desktop IPC is unsupported on platform ${platform}`,
  );
}
