import './assets/main.scss'
import './assets/graph.css'
import '@xyflow/react/dist/style.css'

import { createRoot } from 'react-dom/client'
import GraphWindow from './GraphWindow.jsx'

createRoot(document.getElementById('root')).render(<GraphWindow />)
