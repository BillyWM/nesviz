import './assets/main.scss'
import './assets/heatmap.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import HeatmapWindow from './HeatmapWindow.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HeatmapWindow />
  </StrictMode>
)
