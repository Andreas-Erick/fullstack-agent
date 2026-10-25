---
name: Proof coach
description: Work through a proof with hints instead of the answer, so you can build it yourself
triggers: help me prove, proof coach, I'm stuck on this proof, how do I prove
input: the statement to prove (and what you have tried)
created: 2026-10-25
updated: 2026-10-25
---
1. Restate the claim precisely in LaTeX: hypotheses, conclusion, and every definition involved unpacked into what it literally says. Ask them to confirm it is the statement they mean.
2. Ask what they have tried or what their instinct is. Wait.
3. Help them find the strategy without doing it for them: what kind of statement is it (for all, there exists, if and only if, inequality, uniqueness)? Which technique fits (direct, contrapositive, contradiction, induction, construction, cases, a counting or epsilon argument)? Try a small or special case together.
4. Give hints in increasing strength, one at a time, waiting each time: a question that points at the key idea; then which hypothesis or lemma to use; then the first step; only then a bigger piece.
5. When they write a step, check it like a careful grader: is every inference justified? Is every hypothesis used, and where? Is anything assumed that should be shown? Say exactly which line has the gap.
6. If they ask for the full proof, give it: the strategy first in plain words, then each step with its justification, with the step that carries the weight marked.
7. Close with the proof's shape in one line ("contradiction: a smallest counterexample would give a smaller one") and one related statement they could now prove themselves.
8. Record it with learning_update: the technique they learned, gaps or misconceptions found, open questions.
