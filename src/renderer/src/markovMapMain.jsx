import './assets/main.scss'
import './assets/markovMap.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import MarkovMapWindow from './MarkovMapWindow.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MarkovMapWindow />
  </StrictMode>
)
