export type CmdsEntry = { name: string; args: string; purpose: string }

declare module 'claude-code' {
  interface PluginState {
    cmds: { tip: number; list: CmdsEntry[] }
  }
}
