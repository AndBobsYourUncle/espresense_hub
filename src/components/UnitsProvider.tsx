"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { UnitSystem } from "@/lib/units";

interface UnitsContextValue {
  units: UnitSystem;
  setUnits: (u: UnitSystem) => void;
}

const UnitsContext = createContext<UnitsContextValue | null>(null);

const STORAGE_KEY = "espresense-hub:units";

export function useUnits(): UnitsContextValue {
  const ctx = useContext(UnitsContext);
  if (!ctx) {
    throw new Error("useUnits must be used inside <UnitsProvider>");
  }
  return ctx;
}

export default function UnitsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [units, setUnitsState] = useState<UnitSystem>("metric");

  // Hydrate from localStorage on mount.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "metric" || stored === "imperial") {
        setUnitsState(stored);
      }
    } catch {
      // ignore
    }
  }, []);

  const setUnits = useCallback((next: UnitSystem) => {
    setUnitsState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  return (
    <UnitsContext.Provider value={{ units, setUnits }}>
      {children}
    </UnitsContext.Provider>
  );
}
