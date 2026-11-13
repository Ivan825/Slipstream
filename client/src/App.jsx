import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuth, roleOf, isCrew } from './store/auth.js';
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
import Debrief from './pages/Debrief.jsx';
import { useRealChannel } from './lib/realChannel.js';
import { useMock, useTeamWatch, rememberMock } from './lib/crew.js';
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
  // a crew account always works its own team
  useEffect(() => {
    if (isCrew(auth.user) && useUI.getState().realTeam !== auth.user.team) useUI.getState().setRealTeam(auth.user.team);
  }, [auth.user]);

  if (location.pathname === '/login') return <Login />;
  return <Shell role={role} location={location} />;
}

function Shell({ role, location }) {
  useRooms(['metrics']); // 1 Hz pipeline metrics feed the session bar everywhere
  const source = useUI((s) => s.source);
  const realKey = source.kind === 'real' ? source.key : null;
  useRealChannel(realKey); // every page follows the chosen real session
  useTeamWatch(); // alerts for the crew's cars in real sessions
  const mockId = source.kind === 'real' && String(source.key).startsWith('m-') ? String(source.key).slice(2) : null;
  useEffect(() => {
    useMock.getState().load(mockId);
    if (!mockId) return;
    // crew mates log calls too: keep the shared call log fresh
    const id = setInterval(() => useMock.getState().load(mockId), 15_000);
    return () => clearInterval(id);
  }, [mockId]);

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
          <Route path="/mock/:id" element={<MockEntry />} />
          <Route path="/mock/:id/debrief" element={<MockEntry to="/debrief" />} />
          <Route path="/debrief" element={<Page><Debrief /></Page>} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </AnimatePresence>
      <Overlays />
    </div>
  );
}

/** a mock link (shared by a crew mate or reopened later): switch the app to that mock's private channel */
function MockEntry({ to = '/pitwall' }) {
  const { id } = useParams();
  const ok = /^[a-z0-9]{8,16}$/.test(id || '');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ok) {
      const src = useUI.getState().source;
      if (src.key !== `m-${id}`) useUI.getState().setSource({ kind: 'real', key: `m-${id}`, name: 'Mock session', mock: true });
      rememberMock(id);
    }
    setReady(true);
  }, [id, ok]);
  return ready ? <Navigate to={ok ? to : '/'} replace /> : null;
}
