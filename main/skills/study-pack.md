---
name: Study pack
description: Complete study material for a topic, made to learn from (not just to read) - a vault note, diagrams, exact charts, a printable PDF and flashcards
triggers: study pack, study guide, study material, make me notes, summary sheet, cheat sheet, help me prepare for my exam
input: the topic, and what it is for (an exam, a lecture, a chapter) and the level
created: 2026-10-27
updated: 2026-10-27
---
1. Pin down the scope in one short exchange unless it is already clear: the topic, what it is for (exam date, course, chapter), their level, and what they already find hard (learning_overview helps). If they shared lecture notes, slides or a PDF, read them first and follow their notation and order.
2. Plan the pack in your head: 4-8 core ideas in the order they build on each other, each with what must be understood (not just remembered), the typical mistake, and a worked example.
3. Make the visuals first, each one because it explains something prose can't:
   - a concept map or process (how the ideas connect, a cycle, a pipeline, a timeline, a comparison) as clean inline SVG with diagram_save; label everything, keep it uncluttered, one idea per diagram;
   - every function, curve or data set with chart_create (never draw a plot by hand), with titled axes and units.
   Keep each returned embedInPdf line.
4. Write the study note in the vault with vault_write_note (in the subject's folder, linked to related notes with [[wikilinks]]):
   - Learning goals: what they will be able to do.
   - The big picture in three sentences, then the diagram.
   - Each core idea: the intuition, the precise statement (formulas in LaTeX), why it is true, a worked example with real numbers, and the common mistake.
   - Key formulas and definitions in one table.
   - Practice: 5-10 questions from recall to transfer (explain, compute, compare, apply to something new), with answers at the end, not next to the questions.
   - Self-check: three "can you explain…" questions.
5. Turn the note into a printable PDF with create_pdf: the same content, the embedInPdf lines where the figures belong, a one-page summary sheet first if they asked for revision.
6. Make flashcards for what must be recalled (definitions, formulas, the key steps, the common mistakes as questions) with flashcards_add in a deck named after the subject: one fact per card, the question as a cue that requires recall, cloze cards for formulas and lists.
7. Tell them what you made, in a few lines: the note, the PDF, the deck and how many cards. Offer one next step: a short quiz now (flashcards_mixed or questions from the practice set), or a study session.
