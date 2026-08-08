import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ControlApp } from './ControlApp'
import { ProjectorView } from './ProjectorView'
import './styles.css'

function parseRoute(): { kind: 'control' } | { kind: 'projector'; index: number } {
  const hash = window.location.hash.replace(/^#/, '')
  const m = hash.match(/^\/?projector\/(\d+)/)
  if (m) return { kind: 'projector', index: Number(m[1]) }
  return { kind: 'control' }
}

const route = parseRoute()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {route.kind === 'projector' ? <ProjectorView index={route.index} /> : <ControlApp />}
  </StrictMode>,
)
