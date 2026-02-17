import './assets/main.scss'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import LabelsWindow from './LabelsWindow.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LabelsWindow />
  </StrictMode>
)
