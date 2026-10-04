export type CtxSlimNotified = boolean

declare module 'claude-code' {
  interface PluginState {
    'ctx-slim': {
      /** whether this session has already shown the trimming notice */
      notified: CtxSlimNotified
    }
  }
}
