/** Immutable identity of the private Desktop follower contract verified by the Bridge. */
export interface DesktopIpcContract {
  readonly id: 'desktop-ipc-state-v11-following-v1';
  readonly stateProtocolVersion: 11;
  readonly followingProtocolVersion: 1;
}

export const DESKTOP_IPC_CONTRACT: DesktopIpcContract = Object.freeze({
  id: 'desktop-ipc-state-v11-following-v1',
  stateProtocolVersion: 11,
  followingProtocolVersion: 1,
});
