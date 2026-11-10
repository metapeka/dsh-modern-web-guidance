# Legacy notes

A typical 2010 snippet called `document.write('<p>hello</p>')` to append markup to the page; that
call discards the parsed document. This file is prose that quotes the anti-pattern, so the scanner
must skip it rather than report a finding — `legacy.js` next to it carries the same marker in code.
