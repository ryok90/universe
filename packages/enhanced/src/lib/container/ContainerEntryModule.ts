/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra, Zackary Jackson @ScriptedAlchemy, Marais Rossouw @maraisr
*/

"use strict";

import { OriginalSource, RawSource } from "webpack-sources";
import AsyncDependenciesBlock from "webpack/lib/AsyncDependenciesBlock";
import { Module, Dependency, WebpackError, WebpackOptionsNormalized, Compilation,Resolver,ModuleGraph, ChunkGraph} from "webpack";
import { JAVASCRIPT_MODULE_TYPE_DYNAMIC } from "webpack/lib/ModuleTypeConstants";
import RuntimeGlobals from "webpack/lib/RuntimeGlobals";
import Template from "webpack/lib/Template";
import StaticExportsDependency from "webpack/lib/dependencies/StaticExportsDependency";
import makeSerializable from "webpack/lib/util/makeSerializable";
import ContainerExposedDependency from "./ContainerExposedDependency";

/** @typedef {import("webpack/declarations/WebpackOptions").WebpackOptionsNormalized} WebpackOptions */
/** @typedef {import("webpack/lib/ChunkGraph")} ChunkGraph */
/** @typedef {import("webpack/lib/ChunkGroup")} ChunkGroup */
/** @typedef {import("webpack/lib/Compilation")} Compilation */
/** @typedef {import("webpack/lib/Module").CodeGenerationContext} CodeGenerationContext */
/** @typedef {import("webpack/lib/Module").CodeGenerationResult} CodeGenerationResult */
/** @typedef {import("webpack/lib/Module").LibIdentOptions} LibIdentOptions */
/** @typedef {import("webpack/lib/Module").NeedBuildContext} NeedBuildContext */
/** @typedef {import("webpack/lib/RequestShortener")} RequestShortener */
/** @typedef {import("webpack/lib/ResolverFactory").ResolverWithOptions} ResolverWithOptions */
/** @typedef {import("webpack/lib/WebpackError")} WebpackError */
/** @typedef {import("webpack/lib/serialization/ObjectMiddleware").ObjectDeserializerContext} ObjectDeserializerContext */
/** @typedef {import("webpack/lib/serialization/ObjectMiddleware").ObjectSerializerContext} ObjectSerializerContext */
/** @typedef {import("webpack/lib/util/Hash")} Hash */
/** @typedef {import("webpack/lib/util/fs").InputFileSystem} InputFileSystem */
/** @typedef {import("./ContainerEntryDependency")} ContainerEntryDependency */

/**
 * @typedef {Object} ExposeOptions
 * @property {string[]} import requests to exposed modules (last one is exported)
 * @property {string} name custom chunk name for the exposed module
 */
export type ExposeOptions = {
  import: string[];
  name: string;
};

const SOURCE_TYPES = new Set(["javascript"]);

class ContainerEntryModule extends Module {
	private _name: string;
	private _exposes: Array<[string, ExposeOptions]>;
	private _shareScope: string;

	/**
	 * @param {string} name container entry name
	 * @param {[string, ExposeOptions][]} exposes list of exposed modules
	 * @param {string} shareScope name of the share scope
	 */
	constructor(name: string, exposes: Array<[string, ExposeOptions]>, shareScope: string) {
		super(JAVASCRIPT_MODULE_TYPE_DYNAMIC, null);
		this._name = name;
		this._exposes = exposes;
		this._shareScope = shareScope;
	}

	/**
	 * @returns {Set<string>} types available (do not mutate)
	 */
	override getSourceTypes(): Set<string> {
		return SOURCE_TYPES;
	}

	/**
	 * @returns {string} a unique identifier of the module
	 */
	override identifier(): string {
		return `container entry (${this._shareScope}) ${JSON.stringify(
			this._exposes
		)}`;
	}

	/**
	 * @param {RequestShortener} requestShortener the request shortener
	 * @returns {string} a user readable identifier of the module
	 */
	override readableIdentifier(requestShortener: RequestShortener): string {
		return `container entry`;
	}

	/**
	 * @param {LibIdentOptions} options options
	 * @returns {string | null} an identifier for library inclusion
	 */
	override libIdent(options: LibIdentOptions): string | null {
		return `${this.layer ? `(${this.layer})/` : ""}webpack/container/entry/${
			this._name
		}`;
	}

	/**
	 * @param {NeedBuildContext} context context info
	 * @param {function((WebpackError | null)=, boolean=): void} callback callback function, returns true, if the module needs a rebuild
	 * @returns {void}
	 */
	override needBuild(context: NeedBuildContext, callback: (error?: WebpackError | null, needsRebuild?: boolean) => void): void {
		return callback(null, !this.buildMeta);
	}

	/**
	 * @param {WebpackOptions} options webpack options
	 * @param {Compilation} compilation the compilation
	 * @param {ResolverWithOptions} resolver the resolver
	 * @param {InputFileSystem} fs the file system
	 * @param {function(WebpackError=): void} callback callback function
	 * @returns {void}
	 */
	// override build(options: WebpackOptionsNormalized, compilation: Compilation, resolver: ResolverWithOptions, fs: InputFileSystem, callback: (error?: WebpackError) => void): void {
	override build(options: WebpackOptionsNormalized, compilation: Compilation, resolver: Resolver, fs: object, callback: (error?: WebpackError) => void): void {
		this.buildMeta = {};
		this.buildInfo = {
			strict: true,
			topLevelDeclarations: new Set(["moduleMap", "get", "init"])
		};
		this.buildMeta.exportsType = "namespace";

		this.clearDependenciesAndBlocks();

		for (const [name, options] of this._exposes) {
			const block = new AsyncDependenciesBlock(
				{
					name: options.name
				},
				{ name },
				options.import[options.import.length - 1]
			);
			let idx = 0;
			for (const request of options.import) {
				const dep = new ContainerExposedDependency(name, request);
				dep.loc = {
					name,
					index: idx++
				};

				block.addDependency(dep);
			}
			this.addBlock(block);
		}
		this.addDependency(new StaticExportsDependency(["get", "init"], false));

		callback();
	}

	/**
	 * @param {CodeGenerationContext} context context for code generation
	 * @returns {CodeGenerationResult} result
	 */
	override codeGeneration({ moduleGraph, chunkGraph, runtimeTemplate }: CodeGenerationContext): CodeGenerationResult {
		const sources = new Map();
		const runtimeRequirements = new Set([
			RuntimeGlobals.definePropertyGetters,
			RuntimeGlobals.hasOwnProperty,
			RuntimeGlobals.exports
		]);
		const getters = [];

		for (const block of this.blocks) {
			const { dependencies } = block;

			const modules = dependencies.map((dependency: Dependency) => {
				const dep = dependency as ContainerExposedDependency;
				return {
					name: dep.exposedName,
					module: moduleGraph.getModule(dep),
					request: dep.userRequest
				};
			});

			let str;

			if (modules.some(m => !m.module)) {
				str = runtimeTemplate.throwMissingModuleErrorBlock({
					request: modules.map(m => m.request).join(", ")
				});
			} else {
				str = `return ${runtimeTemplate.blockPromise({
					block,
					message: "",
					chunkGraph,
					runtimeRequirements
				})}.then(${runtimeTemplate.returningFunction(
					runtimeTemplate.returningFunction(
						`(${modules
							.map(({ module, request }) =>
								runtimeTemplate.moduleRaw({
									module,
									chunkGraph,
									request,
									weak: false,
									runtimeRequirements
								})
							)
							.join(", ")})`
					)
				)});`;
			}

			getters.push(
				`${JSON.stringify(modules[0].name)}: ${runtimeTemplate.basicFunction(
					"",
					str
				)}`
			);
		}

		const source = Template.asString([
			`var moduleMap = {`,
			Template.indent(getters.join(",\n")),
			"};",
			`var get = ${runtimeTemplate.basicFunction("module, getScope", [
				`${RuntimeGlobals.currentRemoteGetScope} = getScope;`,
				// reusing the getScope variable to avoid creating a new var (and module is also used later)
				"getScope = (",
				Template.indent([
					`${RuntimeGlobals.hasOwnProperty}(moduleMap, module)`,
					Template.indent([
						"? moduleMap[module]()",
						`: Promise.resolve().then(${runtimeTemplate.basicFunction(
							"",
							"throw new Error('Module \"' + module + '\" does not exist in container.');"
						)})`
					])
				]),
				");",
				`${RuntimeGlobals.currentRemoteGetScope} = undefined;`,
				"return getScope;"
			])};`,
			`var init = ${runtimeTemplate.basicFunction("shareScope, initScope", [
				`if (!${RuntimeGlobals.shareScopeMap}) return;`,
				`var name = ${JSON.stringify(this._shareScope)}`,
				`var oldScope = ${RuntimeGlobals.shareScopeMap}[name];`,
				`if(oldScope && oldScope !== shareScope) throw new Error("Container initialization failed as it has already been initialized with a different share scope");`,
				`${RuntimeGlobals.shareScopeMap}[name] = shareScope;`,
				`return ${RuntimeGlobals.initializeSharing}(name, initScope);`
			])};`,
			"",
			"// This exports getters to disallow modifications",
			`${RuntimeGlobals.definePropertyGetters}(exports, {`,
			Template.indent([
				`get: ${runtimeTemplate.returningFunction("get")},`,
				`init: ${runtimeTemplate.returningFunction("init")}`
			]),
			"});"
		]);

		sources.set(
			"javascript",
			this.useSourceMap || this.useSimpleSourceMap
				? new OriginalSource(source, "webpack/container-entry")
				: new RawSource(source)
		);

		return {
			sources,
			runtimeRequirements
		};
	}

	/**
	 * @param {string=} type the source type for which the size should be estimated
	 * @returns {number} the estimated size of the module (must be non-zero)
	 */
	size(type?: string): number {
		return 42;
	}

	/**
	 * @param {ObjectSerializerContext} context context
	 */
	serialize(context: ObjectSerializerContext): void {
		const { write } = context;
		write(this._name);
		write(this._exposes);
		write(this._shareScope);
		super.serialize(context);
	}

	/**
	 * @param {ObjectDeserializerContext} context context
	 * @returns {ContainerEntryModule} deserialized container entry module
	 */
	static deserialize(context: ObjectDeserializerContext): ContainerEntryModule {
		const { read } = context;
		const obj = new ContainerEntryModule(read(), read(), read());
		obj.deserialize(context);
		return obj;
	}
}

makeSerializable(
	ContainerEntryModule,
	"webpack/lib/container/ContainerEntryModule"
);

module.exports = ContainerEntryModule;
