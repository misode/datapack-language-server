import { INode, SchemaRegistry } from '@mcschema/core'
import * as fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import { Diagnostic, Position, Proposed, Range } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { URI as Uri } from 'vscode-uri'
import { JsonSchemaType } from '../data/JsonSchema'
import { VanillaData } from '../data/VanillaData'
import { DiagnosticMap, getSelectedNode, JsonDocument, JsonNode, NodeRange } from '../nodes'
import { IdentityNode } from '../nodes/IdentityNode'
import { LineParser } from '../parsers/LineParser'
import { LanguageConfig } from '../plugins/LanguageConfigImpl'
import { ErrorCode, isMcfunctionDocument, LineNode, TextRange } from '../types'
import { CacheFile, ClientCache, FileType } from '../types/ClientCache'
import { CommandTree } from '../types/CommandTree'
import { Config } from '../types/Config'
import { DatapackDocument } from '../types/DatapackDocument'
import { DocNode, PathAccessibleFunction, UrisOfIds } from '../types/handlers'
import { constructContext, ParsingContext } from '../types/ParsingContext'
import { TokenModifier, TokenType } from '../types/Token'
import { JsonSchemaHelper } from '../utils/JsonSchemaHelper'
import { StringReader } from '../utils/StringReader'
import { DatapackLanguageService } from './DatapackLanguageService'

export function getUri(str: string) {
    return Uri.parse(str)
}

export function getRootUri(str: string) {
    if (str[str.length - 1] !== '/') {
        str = `${str}/`
    }
    return getUri(str)
}

export function getUriFromId(pathExists: PathAccessibleFunction, roots: Uri[], urisOfIds: UrisOfIds, id: IdentityNode, category: FileType, preferredRoot: Uri): Uri
export async function getUriFromId(pathExists: PathAccessibleFunction, roots: Uri[], urisOfIds: UrisOfIds, id: IdentityNode, category: FileType, preferredRoot?: undefined): Promise<Uri | null>
export function getUriFromId(pathExists: PathAccessibleFunction, roots: Uri[], urisOfIds: UrisOfIds, id: IdentityNode, category: FileType, preferredRoot?: Uri): Uri | Promise<Uri | null> {
    const idString = id.toString()
    const key = `${category}|${idString}`

    if (preferredRoot) {
        const rel = id.toRel(category, 'data')
        const uri = getUri(Uri.file(path.join(preferredRoot.fsPath, rel)).toString())
        return uri
    }

    const value = urisOfIds.get(key)
    if (value !== undefined) {
        return Promise.resolve(value)
    }

    return new Promise(async resolve => {
        const rel = id.toRel(category, 'data')
        for (const root of roots) {
            const abs = path.join(root.fsPath, rel)
            if (await pathExists(abs)) {
                const uri = getUri(Uri.file(abs).toString())
                urisOfIds.set(key, uri)
                resolve(uri)
            }
        }

        resolve(null)
    })
}

export function parseJsonNode({ service, document, config, cache, uri, roots, schema, vanillaData, jsonSchemas, schemaType }: { service: DatapackLanguageService, document: TextDocument, config: Config, cache: ClientCache, uri: Uri, roots: Uri[], schema: INode, jsonSchemas: SchemaRegistry, schemaType: JsonSchemaType, vanillaData: VanillaData }): JsonNode {
    const ans: JsonNode = {
        json: service.jsonService.parseJSONDocument(document) as JsonDocument,
        cache: {}, errors: [], tokens: [], schemaType
    }
    const ctx = constructContext({
        cache: service.getCache(uri),
        id: getId(uri, roots),
        rootIndex: getRootIndex(uri, roots),
        blockDefinition: vanillaData.BlockDefinition,
        namespaceSummary: vanillaData.NamespaceSummary,
        nbtdoc: vanillaData.Nbtdoc,
        registry: vanillaData.Registry,
        config, textDoc: document, roots, service
    }, undefined, vanillaData, jsonSchemas)
    JsonSchemaHelper.validate(ans, ans.json.root, schema, ctx)
    return ans
}

export function parseFunctionNodes(service: DatapackLanguageService, textDoc: TextDocument, start: number = 0, end: number = textDoc.getText().length, nodes: DocNode[], config: Config, cacheFile: CacheFile, uri: Uri, roots: Uri[], cursor = -1, commandTree?: CommandTree, vanillaData?: VanillaData, jsonSchemas?: SchemaRegistry, languageConfigs?: Map<string, LanguageConfig>) {
    const cache = service.getCache(uri)
    const string = textDoc.getText()
    const reader = new StringReader(string, start, end)
    const ctx = constructContext({
        cache, config, cursor, textDoc, roots, service,
        id: getId(uri, roots), rootIndex: getRootIndex(uri, roots)
    }, commandTree, vanillaData, jsonSchemas)
    const syntaxComponents = languageConfigs?.get(textDoc.languageId)?.syntaxComponents ?? []
    let lastCursor = reader.cursor
    while (reader.cursor < reader.end) {
        const matchedComponents = syntaxComponents.filter(v => v.test(reader.clone(), ctx))
        if (matchedComponents.length > 0) {
            // TODO: Handle correctly when there are multiple matched components.
            const start = reader.cursor
            const result = matchedComponents[0].parse(reader, ctx)
            nodes.push({
                [NodeRange]: { start, end: reader.cursor },
                args: [{
                    data: result.data,
                    parser: 'syntax_component'
                }],
                cache: result.cache,
                completions: result.completions,
                errors: result.errors,
                tokens: result.tokens,
                hint: { fix: [], options: [] }
            })
        } else {
            parseFunctionNode({
                textDoc: textDoc,
                start: reader.cursor,
                end: textDoc.offsetAt(Position.create(textDoc.positionAt(reader.cursor).line, Infinity)),
                nodes, reader, ctx
            })
        }
        if (reader.cursor === lastCursor) {
            console.error(`The language server encounters a dead loop when parsing at [${reader.cursor}] with “${reader.remainingString}”`)
            break
        }
        lastCursor = reader.cursor
    }
}

export function parseFunctionNode({ textDoc, reader, start, end, nodes, ctx }: { textDoc: TextDocument, reader: StringReader, start: number, end: number, nodes: DocNode[], ctx: ParsingContext }) {
    const parser = new LineParser(false, 'line')
    const string = textDoc.getText()
    const lineReader = new StringReader(string, start, end)
    let lineEnd = end
    lineReader.skipWhiteSpace()
    while (true) {
        const char = string.charAt(lineReader.end - 1)
        if (StringReader.isWhiteSpace(char) && lineReader.end > start) {
            // Remove the whitespaces at the end of this line
            lineReader.end--
            if (char === '\r' || char === '\n') {
                // Remove the line breaks after the end of this line
                lineEnd--
            }
        } else {
            break
        }
    }
    if (lineReader.remainingString.length === 0) {
        // This empty node will be selected in methods like `onCompletion`.
        if (start !== lineEnd) {
            nodes.push({
                [NodeRange]: { start, end: lineEnd },
                args: [], hint: { fix: [], options: [] }, tokens: []
            })
        } else {
            reader.cursor++
        }
    } else {
        const { data } = parser.parse(lineReader, ctx)
        nodes.push(data)
    }
    reader.cursor = lineReader.cursor
}

export function getRelAndRootIndex(uri: Uri, roots: Uri[]): { rel: string, index: number } | null {
    for (const [i, root] of roots.entries()) {
        if (uri.toString().startsWith(root.toString())) {
            return {
                rel: path.relative(root.fsPath, uri.fsPath),
                index: i
            }
        }
    }
    return null
}

export function getRel(uri: Uri, roots: Uri[]): string | undefined {
    return getRelAndRootIndex(uri, roots)?.rel

}

export function getId(uri: Uri, roots: Uri[]) {
    return IdentityNode.fromRel(getRel(uri, roots))?.id
}

export function getRootIndex(uri: Uri, roots: Uri[]): number | null {
    return getRelAndRootIndex(uri, roots)?.index ?? null
}

export async function getTextDocument({ uri, langId, getText, version }: { uri: Uri, langId?: string, getText: () => Promise<string>, version: number | null }) {
    langId = langId ?? (uri.fsPath.endsWith('json') || uri.fsPath.endsWith('.mcmeta') ? 'json' : 'mcfunction')
    return TextDocument.create(uri.toString(), langId, version as number, await getText())
}

export function getDiagnosticMap(diagnostics: Diagnostic[]) {
    const diagnosticsMap: DiagnosticMap = {}
    for (const diag of diagnostics) {
        if (diag.code !== undefined) {
            const code = diag.code as ErrorCode
            diagnosticsMap[code] = diagnosticsMap[code] || []
            diagnosticsMap[code]!.push(diag)
        }
    }
    return diagnosticsMap
}

/* istanbul ignore next */
export function getSemanticTokensLegend(): Proposed.SemanticTokensLegend {
    const tokenTypes: string[] = []
    for (let i = 0; i < TokenType._; i++) {
        const str = TokenType[i]
        tokenTypes.push(str)
    }

    const tokenModifiers: string[] = []
    for (let i = 0; i < TokenModifier._; i++) {
        const str = TokenModifier[i]
        tokenModifiers.push(str)
    }

    return { tokenTypes, tokenModifiers }
}

export function getLspRange(content: TextDocument, { start, end }: TextRange) {
    return Range.create(content.positionAt(start), content.positionAt(end))
}

export function getStringLines(string: string) {
    return string.split(/\r\n|\r|\n/)
}

export function getSelectedNodeFromInfo(info: DatapackDocument, offset: number): { index: number, node: JsonNode | LineNode | null } {
    return isMcfunctionDocument(info) ? getSelectedNode(info.nodes, offset) : { index: 0, node: info.nodes[0] }
}

export function partitionedIteration<T>(iterator: IterableIterator<T>, onEachItem: (item: T) => any) {
    return new Promise<void>((resolve, reject) => {
        try {
            const help = async () => {
                const { done, value: item } = iterator.next()
                if (!done) {
                    await onEachItem(item)
                    setImmediate(help)
                } else {
                    resolve()
                }
            }
            help()
        } catch (e) {
            reject(e)
        }
    })
}

/* istanbul ignore next */
export async function walkFile(
    workspaceRootPath: string,
    abs: string,
    onFile: (abs: string, rel: string, stat: fs.Stats) => any,
    pathFilter: (abs: string, rel: string, stat: fs.Stats) => Promise<boolean> = () => Promise.resolve(true)
): Promise<any> {
    const names = (await fsp.readdir(abs)).values()
    return partitionedIteration(names, async name => {
        const newAbs = path.join(abs, name)
        const stat = await fsp.stat(newAbs)
        const rel = path.relative(workspaceRootPath, newAbs)
        if (!await pathFilter(newAbs, rel, stat)) {
            return
        }
        if (stat.isDirectory()) {
            return walkFile(workspaceRootPath, newAbs, onFile)
        } else {
            return onFile(newAbs, rel, stat)
        }
    })
}

/* istanbul ignore next */
export async function walkRoot(
    workspaceRoot: Uri,
    abs: string,
    cb: (xabs: string, stat: fs.Stats) => any,
    depth = Infinity
): Promise<any> {
    if (depth <= 0) {
        return
    }
    const names = await fsp.readdir(abs)
    const promises: Promise<any>[] = []
    for (const name of names) {
        const newAbs = path.join(abs, name)
        const stat = await fsp.stat(newAbs)
        if (stat.isDirectory()) {
            cb(newAbs, stat)
            promises.push(walkRoot(workspaceRoot, newAbs, cb, depth - 1))
        }
    }
    return Promise.all(promises)
}
