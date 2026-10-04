export type Shot = {
  path: string
  /** when the session first saw it, ms since the epoch */
  at: number
  /** the tool that produced or read it */
  via: string
  width: number
  height: number
  /** the file's modification time when recorded: a rewrite of the same path is a new screenshot */
  mtimeMs: number
  /** when the person marked it read (r); 0 while unread */
  readAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'shot-view': {
      shots: Shot[]
      /** position in the unread list, 0 = newest */
      index: number
    }
  }
}
