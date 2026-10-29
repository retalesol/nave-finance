import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDaoContext } from '../../hooks/useDaoContext';
import { isMockDaoAddress } from '../../lib/mockData';
import { markWalkthroughSeen } from '../../lib/walkthroughSeen';
import WalkthroughStage from './WalkthroughStage';
import WalkthroughVeil from './WalkthroughVeil';
import { WALKTHROUGH_STEPS } from './steps';

export type WalkthroughLocationState = {
  treasuryAddress?: string;
  /** Real treasury tour (skip demo mock mode). */
  live?: boolean;
  /** Opened from Search — replay even if already seen. */
  replay?: boolean;
};

export default function WalkthroughPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { daoAddress, setDaoAddress, enableMockMode } = useDaoContext();
  const savedAddress = useRef<string | null | undefined>(undefined);
  const stageRef = useRef<HTMLDivElement>(null);
  const routeState = (location.state as WalkthroughLocationState | null) ?? null;

  const treasuryAddress = useMemo(() => {
    const fromState = routeState?.treasuryAddress?.trim();
    if (fromState) return fromState;
    if (daoAddress && !isMockDaoAddress(daoAddress)) return daoAddress;
    return null;
  }, [routeState?.treasuryAddress, daoAddress]);

  const live = Boolean(
    treasuryAddress
    && (routeState?.live || routeState?.replay || (routeState?.treasuryAddress && !isMockDaoAddress(routeState.treasuryAddress))),
  );

  useEffect(() => {
    if (live && treasuryAddress) {
      setDaoAddress(treasuryAddress);
      return;
    }
    if (savedAddress.current === undefined) savedAddress.current = daoAddress;
    enableMockMode();
    return () => {
      const previous = savedAddress.current;
      if (previous === undefined) return;
      setDaoAddress(previous);
    };
    // Mount once: live keeps the real treasury; demo restores the prior address.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [index, setIndex] = useState(0);
  const [ended, setEnded] = useState(false);
  const [closing, setClosing] = useState(false);
  const [brandReveal, setBrandReveal] = useState<'full' | 'mark' | 'none'>('full');
  const step = WALKTHROUGH_STEPS[index] ?? WALKTHROUGH_STEPS[0];

  const finish = () => {
    setBrandReveal('none');
    setClosing(true);
  };

  const leaveTour = () => {
    if (treasuryAddress && !isMockDaoAddress(treasuryAddress)) {
      markWalkthroughSeen(treasuryAddress);
    }
    if (live && treasuryAddress) {
      navigate('/overview', {
        replace: true,
        state: {
          treasuryAddress,
          startOnboarding: !routeState?.replay,
        },
      });
      return;
    }
    setEnded(true);
  };

  return (
    <div style={{ position: 'relative', height: '100vh', overflow: 'hidden', background: '#FAF8F3' }}>
      <WalkthroughStage ref={stageRef} step={step} ended={ended} brandReveal={brandReveal} />
      {ended ? null : (
        <WalkthroughVeil
          stageRef={stageRef}
          step={step}
          index={index}
          total={WALKTHROUGH_STEPS.length}
          closing={closing}
          onBack={() => setIndex((current) => Math.max(0, current - 1))}
          onNext={() => {
            if (index >= WALKTHROUGH_STEPS.length - 1) finish();
            else setIndex((current) => current + 1);
          }}
          onSkip={finish}
          onReveal={setBrandReveal}
          onClosed={leaveTour}
          skipPrelude={live}
        />
      )}
    </div>
  );
}
