---
name: Vocabulary drill
description: Review your due vocabulary cards for a language with spaced repetition
triggers: quiz me on, vocabulary review, review my cards
input: the language
created: 2026-10-25
updated: 2026-10-25
---
1. Call vocab_review for the language. Say how many cards are due and how many are new. If none are due, say when the next one is and offer conversation practice instead.
2. One card at a time: give the meaning (with a hint of context) and ask them to say or write the word or phrase in the target language, ideally inside a short sentence. Wait for each answer.
3. Judge kindly but honestly: the exact answer or a natural alternative is right; a small slip is "hard"; not known is "again". Show the card's example sentence and, for slips, the correct form.
4. Grade each card right away with vocab_grade (again, hard, good or easy).
5. Cards graded "again" come back once more at the end of the round.
6. Close with the count, the next review date, and one phrase worth using today. Log recurring mistakes with learning_update on the language's topic (as misconceptions).
