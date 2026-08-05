import React from 'react'
import { createRoot } from 'react-dom/client'
import { Robot } from './App'
import '../../shared.css'

const container = document.getElementById('root')!
createRoot(container).render(
  <React.StrictMode>
    <Robot />
  </React.StrictMode>
)
