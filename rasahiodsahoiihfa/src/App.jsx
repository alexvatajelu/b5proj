import { useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from './assets/vite.svg'
import heroImg from './assets/hero.png'
import './App.css'

function App() {
  return (
    <div className="output">
      <div className="outconnectionsx">
        <div className="inconnection" />
        <div className="inconnection" />
        <div className="inconnection" />
      </div>
      <div className="outconnectionsy">
        <div className="inconnection" />
        <div className="inconnection" />
        <div className="inconnection" />
      </div>
      <div className="outchannelsx">
        <div className="graph" />
        <div className="graph" />
        <div className="graph" />
        <div className="enable" />
        <div className="enable" />
        <div className="enable" />
        <p className="text-1">x by x</p>
        <p className="text-2">x by y</p>
        <p className="text-3">x by br</p>
      </div>
      <div className="outchannelsy">
        <div className="graph" />
        <div className="graph" />
        <div className="graph" />
        <div className="enable" />
        <div className="enable" />
        <div className="enable" />
        <p className="text-4">y by x</p>
        <p className="text-5">y by y</p>
        <p className="text-6">y by br</p>
      </div>
    </div>
  )
}


export default App
