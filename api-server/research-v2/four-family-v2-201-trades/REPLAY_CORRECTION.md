# Entry-minute integrity correction

The first development replay incorrectly placed recorded entries at the decision minute's open. Broker fills actually occurred later within that minute. On September 4 at 12:30 UTC, trades 226 and 227 followed a large intraminute move; the earlier open was wrongly interpreted as a post-entry gap stop. The preliminary control totals were invalid and are superseded by RESULTS.json.

The corrected control uses confirmed broker openTime, fill entry, and rounded original stop where available. Unbrokered models retain their recorded entry and decision minute, with unknown intraminute timing. For every recorded control, if either exit barrier is touched anywhere within the entry minute, the result is ENTRY_BAR_UNRESOLVED: M1 extrema cannot establish whether that touch preceded the actual fill. If neither barrier is touched, the replay can proceed. Subsequent minutes retain conservative stop-first and adverse gap handling. Confirmed actual broker outcomes remain available separately even when this counterfactual replay is unscorable.

V2 entries are planned at a known executable M1 open, so their timing rule and results are unchanged. No signal, threshold, confirmation window, stop, target, or acceptance criterion was tuned after seeing results. This correction addresses invalid event ordering rather than strategy performance. PROTOCOL.md is retained unchanged as the original preregistration.

Price-risk R includes executable spreads and fill slippage, but is not an account return or an exact all-fees cash return. All 173 recovered broker trades report zero financing. Separate transaction commissions were not collected. Cash P&L and nominal-budget R are preserved independently.
