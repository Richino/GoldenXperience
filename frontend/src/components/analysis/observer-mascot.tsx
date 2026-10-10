import Image from "next/image";
import { OBSERVER_MASCOT_ASSETS, type ObserverMascotExpression } from "@/lib/observer-mascot";
import styles from "./market-observer-bubble.module.css";

export function ObserverMascot({ expression, reactionKey }: { expression: ObserverMascotExpression; reactionKey?: string }) {
  const asset = OBSERVER_MASCOT_ASSETS[expression];
  return <picture className={styles.face} data-expression={expression} key={`${expression}:${reactionKey ?? "idle"}`}>
    <source media="(prefers-reduced-motion: reduce)" srcSet={asset.still} />
    <Image src={asset.animation} alt="" width={96} height={96} unoptimized loading="eager" draggable={false} />
  </picture>;
}
