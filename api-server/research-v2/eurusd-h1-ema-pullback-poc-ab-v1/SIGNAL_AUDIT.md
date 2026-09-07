# Signal audit — first 10 LONG and 10 SHORT raw opportunities

Automated inequality checks on the frozen rules. This is Phase 1 sanity, not optimization.

| id | signal time | dir | close | EMA20 | EMA50 | EMA50-5 | trend ok | stop | entry | spread pips | target | yPOC | POC rel | A | B |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| OPP-00001 | 2019-01-06T22:00:00.000000000Z | long | 1.14051 | 1.13979 | 1.13958 | 1.13946 | true | 1.13930 | 1.14062 | 2.40 | 1.14326 |  | unavailable | SPREAD_TOO_WIDE | SPREAD_TOO_WIDE |
| OPP-00002 | 2019-01-07T07:00:00.000000000Z | long | 1.14365 | 1.14119 | 1.14033 | 1.13987 | true | 1.14082 | 1.14375 | 1.30 | 1.14961 | 1.14092 | above | TAKE | TAKE |
| OPP-00003 | 2019-01-08T09:00:00.000000000Z | long | 1.14521 | 1.14507 | 1.14372 | 1.14350 | true | 1.14312 | 1.14527 | 1.30 | 1.14957 | 1.14673 | below | TAKE | BLOCKED_BY_POC |
| OPP-00004 | 2019-01-08T11:00:00.000000000Z | long | 1.14658 | 1.14517 | 1.14386 | 1.14357 | true | 1.14324 | 1.14660 | 1.30 | 1.15332 | 1.14673 | below | TAKE | BLOCKED_BY_POC |
| OPP-00005 | 2019-01-08T17:00:00.000000000Z | long | 1.14545 | 1.14479 | 1.14395 | 1.14390 | true | 1.14238 | 1.14554 | 1.20 | 1.15186 | 1.14673 | below | TAKE | BLOCKED_BY_POC |
| OPP-00006 | 2019-01-08T23:00:00.000000000Z | long | 1.14575 | 1.14465 | 1.14405 | 1.14396 | true | 1.14344 | 1.14587 | 1.80 | 1.15073 | 1.14673 | below | TAKE | BLOCKED_BY_POC |
| OPP-00007 | 2019-01-09T13:00:00.000000000Z | long | 1.14623 | 1.14551 | 1.14480 | 1.14461 | true | 1.14370 | 1.14627 | 1.50 | 1.15141 | 1.14409 | above | TAKE | TAKE |
| OPP-00008 | 2019-01-09T14:00:00.000000000Z | long | 1.15246 | 1.14617 | 1.14510 | 1.14467 | true | 1.14442 | 1.15250 | 1.40 | 1.16866 | 1.14409 | above | TAKE | TAKE |
| OPP-00009 | 2019-01-11T01:00:00.000000000Z | long | 1.15178 | 1.15149 | 1.15063 | 1.15060 | true | 1.14945 | 1.15182 | 1.50 | 1.15656 | 1.15247 | below | TAKE | BLOCKED_BY_POC |
| OPP-00010 | 2019-01-11T10:00:00.000000000Z | long | 1.15348 | 1.15218 | 1.15124 | 1.15092 | true | 1.15136 | 1.15354 | 1.30 | 1.15790 | 1.15247 | above | TAKE | TAKE |
| OPP-00011 | 2019-01-14T09:00:00.000000000Z | short | 1.14624 | 1.14784 | 1.14905 | 1.14942 | true | 1.14840 | 1.14618 | 1.40 | 1.14174 | 1.14624 | above | TAKE | BLOCKED_BY_POC |
| OPP-00012 | 2019-01-14T18:00:00.000000000Z | short | 1.14698 | 1.14732 | 1.14840 | 1.14867 | true | 1.14819 | 1.14695 | 1.30 | 1.14447 | 1.14624 | above | SPREAD_TOO_WIDE | SPREAD_TOO_WIDE |
| OPP-00013 | 2019-01-15T07:00:00.000000000Z | short | 1.14706 | 1.14759 | 1.14809 | 1.14813 | true | 1.14854 | 1.14696 | 1.20 | 1.14380 | 1.14680 | above | TAKE | BLOCKED_BY_POC |
| OPP-00014 | 2019-01-16T19:00:00.000000000Z | short | 1.13976 | 1.14035 | 1.14233 | 1.14282 | true | 1.14120 | 1.13970 | 1.40 | 1.13670 | 1.14282 | below | TAKE | TAKE |
| OPP-00015 | 2019-01-16T20:00:00.000000000Z | short | 1.13922 | 1.14025 | 1.14221 | 1.14268 | true | 1.14120 | 1.13916 | 1.40 | 1.13508 | 1.14282 | below | TAKE | TAKE |
| OPP-00016 | 2019-01-17T01:00:00.000000000Z | short | 1.13942 | 1.13998 | 1.14173 | 1.14221 | true | 1.14028 | 1.13937 | 1.40 | 1.13755 | 1.14018 | below | SPREAD_TOO_WIDE | SPREAD_TOO_WIDE |
| OPP-00017 | 2019-01-17T15:00:00.000000000Z | short | 1.13806 | 1.13938 | 1.14063 | 1.14093 | true | 1.14068 | 1.13803 | 1.20 | 1.13273 | 1.14018 | below | TAKE | TAKE |
| OPP-00018 | 2019-01-17T18:00:00.000000000Z | short | 1.13816 | 1.13914 | 1.14038 | 1.14082 | true | 1.13965 | 1.13809 | 1.20 | 1.13497 | 1.14018 | below | TAKE | TAKE |
| OPP-00019 | 2019-01-18T05:00:00.000000000Z | short | 1.13891 | 1.13919 | 1.13997 | 1.14011 | true | 1.13992 | 1.13884 | 1.40 | 1.13668 | 1.13892 | below | SPREAD_TOO_WIDE | SPREAD_TOO_WIDE |
| OPP-00020 | 2019-01-18T14:00:00.000000000Z | short | 1.13742 | 1.13941 | 1.13986 | 1.13990 | true | 1.14124 | 1.13731 | 2.10 | 1.12945 | 1.13892 | below | TAKE | TAKE |

## Rule reminders verified in code

- LONG trend: EMA20 > EMA50 and EMA50 > EMA50 five completed H1 bars ago
- LONG pullback: low ≤ EMA20, close > EMA20, close > previous high
- SHORT is the mirror
- Stop uses three completed H1 bars including the signal bar, minus/plus 2 pips
- Target is 2R from executable entry, not from signal close
- B filters only with yesterday UTC-day POC vs signal close
