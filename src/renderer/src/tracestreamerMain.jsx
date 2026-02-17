import './assets/main.scss'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import TraceStreamerWindow from './TraceStreamerWindow.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <TraceStreamerWindow />
  </StrictMode>
)
