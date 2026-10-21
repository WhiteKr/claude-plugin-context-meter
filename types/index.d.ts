export type Category = { name: string; tokens: number }

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  tokens?: number
  window: number
  rateLimits: RateLimit[]
  costUsd?: number
}

export type Detail = {
  categories: Category[]
  autoCompactAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-meter': {
      snapshot: Snapshot | null
      detail: Detail | null
      samples: number[]
      isOpen: boolean
      warned: string[]
    }
  }
}
