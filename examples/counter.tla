---- MODULE CounterMachine ----
EXTENDS Naturals, Sequences

StateDomain == [count : 0..2]
CommandDomain == {"go", "finish"}
InitialStates == {[count |-> 0]}

Step(s, c) == [
  state |-> [count |-> IF s.count < 2 THEN s.count + 1 ELSE s.count],
  commands |-> IF c = "go" /\ s.count = 0 THEN <<"finish">> ELSE <<>>
]

Invariant(s) == s.count <= 2
====
