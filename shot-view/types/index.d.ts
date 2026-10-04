export type Shot = {
  path: string
  /** when the session first saw it, ms since the epoch */
  at: number
  /** the tool that produced or read it */
  via: string
  width: number
  height: number
}

declare module 'claude-code' {
  interface PluginState {
    'shot-view': {
      shots: Shot[]
      index: number
    }
  }
}
