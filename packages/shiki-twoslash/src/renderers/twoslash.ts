type Lines = import("shiki").IThemedToken[][]
type TwoSlash = import("@typescript/twoslash").TwoSlashReturn

import { TwoslashShikiOptions } from ".."
import { shouldBeHighlightable, shouldHighlightLine } from "../parseCodeFenceInfo"
import { createHighlightedString, subTripleArrow, replaceTripleArrowEncoded, escapeHtml } from "../utils"
import { HtmlRendererOptions, preOpenerFromRenderingOptsWithExtras } from "./plain"

// OK, so - this is just straight up complex code.

// What we're trying to do is merge two sets of information into a single tree for HTML

// 1: Syntax highlight info from shiki
// 2: Twoslash metadata like errors, identifiers etc

// Because shiki gives use a set of lines to work from, then the first thing which happens
// is converting twoslash data into the same format.

// Things which make it hard:
//
// - Twoslash results can be cut, so sometimes there is edge cases between twoslash results
// - Twoslash results can be multi-file
// - the DOM requires a flattened graph of html elements (e.g. spans can' be interspersed)
//

export function twoslashRenderer(lines: Lines, options: HtmlRendererOptions & TwoslashShikiOptions, twoslash: TwoSlash, codefenceMeta: any) {
  let html = ""

  const hasHighlight = shouldBeHighlightable(codefenceMeta)
  const hl = shouldHighlightLine(codefenceMeta)

  html += preOpenerFromRenderingOptsWithExtras(options, codefenceMeta, ["twoslash", "lsp"])
  if (codefenceMeta.title) {
    html += `<div class='code-title'>${codefenceMeta.title}</div>`
  }

  if (options.langId) {
    html += `<div class="language-id">${options.langId}</div>`
  }

  html += `<div class='code-container'><code>`

  const errorsGroupedByLine = groupBy(twoslash.errors, e => e.line) || new Map()
  const staticQuickInfosGroupedByLine = groupBy(twoslash.staticQuickInfos, q => q.line) || new Map()
  // A query is always about the line above it!
  const queriesGroupedByLine = groupBy(twoslash.queries, q => q.line - 1) || new Map()

  /**
   * This is the index of the original twoslash code reference, it is not
   * related to the HTML output
   */
  let filePos = 0

  lines.forEach((l, i) => {
    const errors = errorsGroupedByLine.get(i) || []
    const lspValues = staticQuickInfosGroupedByLine.get(i) || []
    const queries = queriesGroupedByLine.get(i) || []

    if (l.length === 0 && i === 0) {
      // Skip the first newline if it's blank
      filePos += 1
    } else if (l.length === 0) {
      filePos += 1
      html += `\n`
    } else {
      const hiClass = hasHighlight ? (hl(i) ? " highlight" : " dim") : ""
      const prefix = `<div class='line${hiClass}'>`
      html += prefix

      // Keep track of the position of the current token in a line so we can match it up to the
      // errors and lang serv identifiers
      let tokenPos = 0

      l.forEach(token => {
        let targetedQueryWord: typeof twoslash.staticQuickInfos[number] | undefined

        let tokenContent = ""
        // Underlining particular words
        const findTokenFunc = (start: number) => (e: any) =>
          start <= e.character && start + token.content.length >= e.character + e.length

        const findTokenDebug = (start: number) => (e: any) => {
          const result = start <= e.character && start + token.content.length >= e.character + e.length
          // prettier-ignore
          console.log(result, start, '<=', e.character, '&&', start + token.content.length, '>=', e.character + e.length)
          if (result) {
            console.log("Found:", e)
            console.log("Inside:", token)
          }
          return result
        }

        const errorsInToken = errors.filter(findTokenFunc(tokenPos))
        const lspResponsesInToken = lspValues.filter(findTokenFunc(tokenPos))
        const queriesInToken = queries.filter(findTokenFunc(tokenPos))

        // Does this line have a word targeted by a query?
        targetedQueryWord = targetedQueryWord || lspResponsesInToken.find(response => response.text === (queries.length && queries[0].text))!

        const allTokens = [...errorsInToken, ...lspResponsesInToken, ...queriesInToken]
        const allTokensByStart = allTokens.sort((l, r) => {
          return (l.start || 0) - (r.start || 0)
        })

        if (allTokensByStart.length) {
          const ranges = allTokensByStart.map(token => {
            const range: any = {
              begin: token.start! - filePos,
              end: token.start! + token.length! - filePos,
            }

            // prettier-ignore
            if (range.begin < 0 || range.end < 0) {
              // prettier-ignore
              // throw new Error(`The begin range of a token is at a minus location, filePos:${filePos} current token: ${JSON.stringify(token, null, '  ')}\n result: ${JSON.stringify(range, null, '  ')}`)
            }

            if ("renderedMessage" in token) range.classes = "err"
            if ("kind" in token) range.classes = token.kind
            if ("targetString" in token) {
              range.classes = "lsp"
              range["lsp"] = token.text
            }
            return range
          })

          tokenContent += createHighlightedString(ranges, token.content, targetedQueryWord?.text)
        } else {
          tokenContent += subTripleArrow(token.content)
        }

        html += `<span style="color: ${token.color}">${tokenContent}</span>`
        tokenPos += token.content.length
        filePos += token.content.length
      })

      html += `</div>`
      // This is the \n which the </div> represents
      filePos += 1
    }

    // Adding error messages to the line after
    if (errors.length) {
      const messages = errors.map(e => escapeHtml(e.renderedMessage)).join("</br>")
      const codes = errors.map(e => e.code).join("<br/>")
      html += `<span class="error"><span>${messages}</span><span class="code">${codes}</span></span>`
      html += `<span class="error-behind">${messages}</span>`
    }

    // Add queries to the next line
    if (queries.length) {
      queries.forEach(query => {
        switch (query.kind) {
          case "query": {
            const queryTextWithPrefix = escapeHtml(query.text!)
            const lspValues = staticQuickInfosGroupedByLine.get(i) || []
            const targetedWord = lspValues.find(response => response.text === (queries.length && queries[0].text))!
            const halfWayAcrossTheTargetedWord = ((targetedWord && targetedWord.character + targetedWord?.length / 2) - 1) || 0
            html +=
              `<span class='popover-prefix'>` +
              " ".repeat(halfWayAcrossTheTargetedWord) +
              "</span>" +
              `<span class='popover'><div class='arrow'></div>${queryTextWithPrefix}</span>`
            break
          }

          case "completions": {
            if (!query.completions) {
              html += `<span class='query'>${"//" + "".padStart(query.offset - 2) + "^ - No completions found"}</span>`
            } else {
              const prefixed = query.completions.filter(c => c.name.startsWith(query.completionsPrefix || "____"))

              const lis = prefixed
                .sort((l, r) => l.name.localeCompare(r.name))
                .map(c => {
                  const after = c.name.substr(query.completionsPrefix?.length || 0)
                  const name = `<span><span class='result-found'>${query.completionsPrefix || ""}</span>${after}<span>`
                  const isDeprecated = c.kindModifiers?.split(",").includes("deprecated")
                  const liClass = isDeprecated ? "deprecated" : ""
                  return `<li class='${liClass}'>${name}</li>`
                })
                .join("")
              html +=
                "".padStart(query.offset) + `<span class='inline-completions'><ul class='dropdown'>${lis}</ul></span>`
            }
          }
        }
      })
      html += "\n"
    }
  })
  html = replaceTripleArrowEncoded(html.replace(/\n*$/, "")) // Get rid of final new lines

  if (options.addTryButton) {
    const playgroundLink = `<a class='playground-link' href='${twoslash.playgroundURL}'>Try</a>`
    html += `</code>${playgroundLink}`
  } else {
    html += `</code>`
  }

  html += `</div></pre>`
  return html
}

/** Returns a map where all the keys are the value in keyGetter  */
function groupBy<T>(list: T[], keyGetter: (obj: any) => number) {
  const map = new Map<number, T[]>()
  list.forEach(item => {
    const key = keyGetter(item)
    const collection = map.get(key)
    if (!collection) {
      map.set(key, [item])
    } else {
      collection.push(item)
    }
  })
  return map
}
