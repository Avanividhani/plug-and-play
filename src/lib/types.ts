export type MediaItem = {
  id: string
  name: string
  type: 'image' | 'video' | 'ai'
  url: string
  thumbnail?: string
  recipe?: import('./aiContent').GenRecipe
  /** Original text prompt when AI-generated */
  prompt?: string
  /** Where the media came from */
  source?: 'upload' | 'stable-diffusion' | 'procedural' | 'test'
}

export type AppEvent = {
  id: string
  at: number
  kind: 'connect' | 'disconnect' | 'info' | 'warn' | 'danger'
  message: string
}

export type Toast = {
  id: string
  kind: 'connect' | 'disconnect' | 'info'
  message: string
}

export type CalStatus = 'idle' | 'running' | 'done' | 'error'
