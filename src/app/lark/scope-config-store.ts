import { ConfigurationError } from '../config';
import { bridgeConfigPaths, readOrMigratePersistedEnvironment, writeBridgeConfigFile } from '../config-file';

export interface LarkScope {
  readonly tenantKey: string;
  readonly allowedChats: string;
  readonly authorizedUsers?: string;
  readonly allowedApprovers?: string;
}

/**
 * Persists only the Feishu event scope learned during first private-chat use.
 * This is configuration bootstrap state, not task/runtime state.
 */
export class LarkScopeConfigStore {
  public constructor(private readonly configHome: string) {
    if (!configHome.trim()) {
      throw new ConfigurationError('config home must not be blank');
    }
  }

  public save(scope: LarkScope): void {
    if (!scope.tenantKey.trim()) {
      throw new ConfigurationError('LARK_TENANT_KEY must not be blank');
    }
    if (!scope.allowedChats.trim()) {
      throw new ConfigurationError('ALLOWED_CHATS must not be blank');
    }

    const paths = bridgeConfigPaths(this.configHome);
    const configEnv = readOrMigratePersistedEnvironment(paths);
    configEnv.LARK_TENANT_KEY = scope.tenantKey.trim();
    configEnv.ALLOWED_CHATS = scope.allowedChats.trim();
    if (scope.authorizedUsers?.trim()) {
      configEnv.AUTHORIZED_USERS = scope.authorizedUsers.trim();
    }
    if (scope.allowedApprovers?.trim()) {
      configEnv.ALLOWED_APPROVERS = scope.allowedApprovers.trim();
    }
    writeBridgeConfigFile(this.configHome, configEnv);
  }
}
