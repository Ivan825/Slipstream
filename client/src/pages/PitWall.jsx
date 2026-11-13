import { useEffect } from 'react';
import { carsOfTeam } from '@slipstream/shared';
import { useRooms } from '../lib/live.js';
import { useAuth } from '../store/auth.js';
import { useSession, useUI, useTiming } from '../store/stores.js';
import TrackMap from '../components/TrackMap.jsx';
import TimingTower from '../components/TimingTower.jsx';
import { CarCard, AlertFeed, StrategyMini, WeatherCard, RunMonitor, QualiPanel } from '../components/Panels.jsx';

export default function PitWall() {
  const user = useAuth((s) => s.user);
  const type = useSession((s) => s.session?.type || 'race');
  const sel = useUI((s) => s.selected);
  const select = useUI((s) => s.select);
  const order = useTiming((s) => s.order);
  const teamRooms = user?.role === 'engineer' ? [`team:${user.team}`] : [];
  useRooms(['race', 'timing', 'metrics', ...teamRooms]);

  // default selection: the engineer's lead car, otherwise the leader
  useEffect(() => {
    if (sel) return;
    if (user?.role === 'engineer') select(carsOfTeam(user.team)[0].id);
    else if (order[0]) select(order[0]);
  }, [sel, user, order, select]);

  return (
    <div className="grid-pit">
      <TimingTower />
      <TrackMap />
      <div className="rcol">
        <CarCard />
        {type === 'race' && (user ? <StrategyMini /> : <WeatherCard />)}
        {type === 'practice' && <RunMonitor />}
        {type === 'qualifying' && <QualiPanel />}
        <AlertFeed />
      </div>
    </div>
  );
}
