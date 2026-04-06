import './assets/main.scss'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import AnalysisLogWindow from './AnalysisLogWindow.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AnalysisLogWindow />
  </StrictMode>
)
