import './assets/main.scss'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import RomListWindow from './RomListWindow.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RomListWindow />
  </StrictMode>
)
