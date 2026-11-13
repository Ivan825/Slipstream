import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuth, roleOf } from './store/auth.js';
import { connectLive, useRooms } from './lib/live.js';
import Nav from './components/Nav.jsx';
import SessionBar from './components/SessionBar.jsx';
import Overlays from './components/Overlays.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import PitWall from './pages/PitWall.jsx';
import Telemetry from './pages/Telemetry.jsx';
import Strategy from './pages/Strategy.jsx';
import Analysis from './pages/Analysis.jsx';
import RaceControl from './pages/RaceControl.jsx';
import Systems from './pages/Systems.jsx';
import Replay, { Channel } from './pages/Replay.jsx';
import RealTelemetry from './pages/RealTelemetry.jsx';
import RealAnalysis from './pages/RealAnalysis.jsx';
import RealStrategy from './pages/RealStrategy.jsx';
import { useRealChannel } from './lib/realChannel.js';
import { useUI } from './store/stores.js';

function Page({ children }) {
  return (
    <motion.main className="page" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.22 }}>
      {children}
    </motion.main>
  );
}

export default function App() {
  const auth = useAuth();
  const role = roleOf(auth);
  const location = useLocation();

  useEffect(() => {
    connectLive(auth.token); // anonymous sockets get the public viewer feed
  }, [auth.token]);

  if (location.pathname === '/login') return <Login />;
  return <Shell role={role} location={location} />;
}

function Shell({ role, location }) {
  useRooms(['metrics']); // 1 Hz pipeline metrics feed the session bar everywhere
  const source = useUI((s) => s.source);
  const realKey = source.kind === 'real' ? source.key : null;
  useRealChannel(realKey); // every page follows the chosen real session

  return (
    <div className="shell">
      <Nav />
      <SessionBar />
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname.split('/')[1] + (realKey || 'sim')}>
          <Route path="/" element={<Page><Home /></Page>} />
          <Route path="/pitwall" element={<Page>{realKey ? <Channel channelKey={realKey} key={realKey} /> : <PitWall />}</Page>} />
          <Route path="/car/:id" element={<Page>{realKey ? <RealTelemetry /> : <Telemetry />}</Page>} />
          <Route path="/strategy" element={<Page>{realKey ? <RealStrategy /> : <Strategy />}</Page>} />
          <Route path="/analysis" element={<Page>{realKey ? <RealAnalysis /> : <Analysis />}</Page>} />
          <Route path="/control" element={role === 'race_control' ? <Page><RaceControl /></Page> : <Navigate to="/login" />} />
          <Route path="/systems" element={<Page><Systems /></Page>} />
          <Route path="/real" element={<Page><Replay /></Page>} />
          <Route path="/real/:key" element={<Page><Replay /></Page>} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </AnimatePresence>
      <Overlays />
    </div>
  );
}
