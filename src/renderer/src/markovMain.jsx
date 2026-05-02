import React from 'react';
import ReactDOM from 'react-dom/client';
import MarkovWindow from './MarkovWindow.jsx';
import './assets/main.scss';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MarkovWindow />
  </React.StrictMode>
);
