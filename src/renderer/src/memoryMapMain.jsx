import './assets/main.scss'
import './assets/memoryMap.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import MemoryMapWindow from './MemoryMapWindow.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MemoryMapWindow />
  </StrictMode>
)
