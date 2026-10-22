export type DecideItem = {
  id: string
  question: string
  options: string[]
  recommended: string
  context: string
  choice: string
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    decide: { items: DecideItem[] }
  }
}
