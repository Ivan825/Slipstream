import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuth, roleOf } from './store/auth.js';
import { connectLive, useRooms } from './lib/live.js';
import Nav from './components/Nav.jsx';
import SessionBar from './components/SessionBar.jsx';
import Overlays from './components/Overlays.jsx';
import Login from './pages/Login.jsx';
import PitWall from './pages/PitWall.jsx';
import Telemetry from './pages/Telemetry.jsx';
import Strategy from './pages/Strategy.jsx';
import Analysis from './pages/Analysis.jsx';
import RaceControl from './pages/RaceControl.jsx';
import Systems from './pages/Systems.jsx';
import Replay from './pages/Replay.jsx';

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
    if (role) connectLive(auth.token);
  }, [role, auth.token]);

  if (!role) return <Login />;
  return <Shell role={role} location={location} />;
}

function Shell({ role, location }) {
  useRooms(['metrics']); // 1 Hz pipeline metrics feed the session bar everywhere

  return (
    <div className="shell">
      <Nav />
      <SessionBar />
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname.split('/')[1]}>
          <Route path="/" element={<Page><PitWall /></Page>} />
          <Route path="/car/:id" element={<Page><Telemetry /></Page>} />
          <Route path="/strategy" element={<Page><Strategy /></Page>} />
          <Route path="/analysis" element={<Page><Analysis /></Page>} />
          <Route path="/control" element={role === 'race_control' ? <Page><RaceControl /></Page> : <Navigate to="/" />} />
          <Route path="/systems" element={<Page><Systems /></Page>} />
          <Route path="/real" element={<Page><Replay /></Page>} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </AnimatePresence>
      <Overlays />
    </div>
  );
}
