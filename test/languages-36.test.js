import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { extractFile, warmDepthGrammars } from "../src/graph/extract.js";
import { extractContainer, warmContainerGrammars } from "../src/graph/container.js";
import { extractGeneric, warmGenericGrammars } from "../src/graph/generic.js";
import { languageLabelOf, languageOf } from "../src/graph/languages.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { buildGraph } from "../src/graph/build.js";
import { loadGraphCached } from "../src/context/graph-store.js";

test("36-language extraction & cross-file resolution coverage", async (t) => {
    await warmDepthGrammars();
    await warmContainerGrammars(["vue", "svelte", "astro"]);
    await warmGenericGrammars();

    await t.test("Depth tier: TS/JSX/CJS, Python, Go, Java, Kotlin, Swift, PHP, R", () => {
        // 1. TS/JSX/CJS
        const tsx = extractFile("src/App.tsx", [
            "import { LocalCard } from './card';",
            "import * as Ns from './ns';",
            "function Header() { return null; }",
            "function Component(target: any) {}",
            "@Component",
            "export class Panel extends React.Component {",
            "  repo = new Repo();",
            "  render() {",
            "    return <><Header /><LocalCard /><Ns.Btn /></>;",
            "  }",
            "}",
        ].join("\n"), "tsx");
        assert.ok(tsx.rawEdges.some((e) => e.relation === "references" && e.name === "Header"), "same-file JSX <Header />");
        assert.ok(tsx.rawEdges.some((e) => e.relation === "references" && e.name === "LocalCard" && e.specifier === "./card"), "imported JSX <LocalCard />");
        assert.ok(tsx.rawEdges.some((e) => e.relation === "references" && e.name === "Btn" && e.specifier === "./ns"), "member JSX <Ns.Btn />");
        assert.ok(tsx.rawEdges.some((e) => e.relation === "references" && e.name === "Component"), "@Decorator reference");
        assert.ok(tsx.rawEdges.some((e) => e.relation === "extends" && e.name === "Component"), "qualified extends React.Component");
        assert.ok(tsx.rawEdges.some((e) => e.relation === "calls" && e.name === "Repo"), "TS new Repo() constructor edge");

        const cjs = extractFile("src/reset.js", [
            "const helper = require('./helper').validate;",
            "function send(uid) { return helper(uid); }",
            "exports.VERSION = 2;",
            "module.exports = { send };",
        ].join("\n"), "typescript");
        assert.ok(cjs.nodes.some((n) => n.name === "VERSION" && n.exported), "exports.VERSION constant node");
        assert.ok(cjs.nodes.some((n) => n.name === "send" && n.exported), "module.exports = { send } marks exported");
        assert.ok(cjs.rawEdges.some((e) => e.relation === "calls" && e.name === "validate" && e.specifier === "./helper"), "chained require().prop");

        // 2. Python
        const py = extractFile("pkg/proc.py", [
            "import pkg.auth",
            "from . import sub",
            "MAX_RETRIES = 3",
            "type ProcId = int",
            "class GUIProcess(BaseProc[int]):",
            "    def on_err(self):",
            "        super().error()",
        ].join("\n"), "python");
        assert.ok(py.nodes.some((n) => n.name === "MAX_RETRIES" && n.kind === "constant"));
        assert.ok(py.nodes.some((n) => n.name === "ProcId" && n.kind === "type"));
        assert.ok(py.rawEdges.some((e) => e.relation === "extends" && e.name === "BaseProc"));
        assert.ok(py.rawEdges.some((e) => e.relation === "imports" && e.specifier === ".sub"));
        assert.ok(py.rawEdges.some((e) => e.relation === "calls" && e.name === "error" && e.recvType === "BaseProc"), "super().error()");

        // 3. Go
        const go = extractFile("internal/svc.go", [
            "package internal",
            "const MaxConn = 10",
            "type Base struct{}",
            "type Repo struct{}",
            "func (r *Repo) Save() {}",
            "type Service struct { Base; repo *Repo }",
            "func (s *Service) Run() { s.repo.Save() }",
        ].join("\n"), "go");
        assert.ok(go.nodes.some((n) => n.name === "MaxConn" && n.kind === "constant"));
        assert.ok(go.rawEdges.some((e) => e.relation === "extends" && e.name === "Base"), "Go struct embedding");
        assert.ok(go.rawEdges.some((e) => e.relation === "calls" && e.name === "Save" && e.recvType === "Repo"), "Go chained s.repo.Save()");

        // 4. Java + Kotlin + Swift + PHP + R
        const java = extractFile("src/UserService.java", [
            "import com.acme.Repo;",
            "enum Role { ADMIN }",
            "class UserService { private final Repo repo; void save() { new Outer.Inner(); repo::flush; } }",
        ].join("\n"), "java");
        assert.ok(java.nodes.some((n) => n.name === "ADMIN" && n.kind === "field"));
        assert.ok(java.rawEdges.some((e) => e.relation === "calls" && e.name === "Outer.Inner"));
        assert.ok(java.rawEdges.some((e) => e.relation === "calls" && e.name === "flush" && e.recvType === "Repo"));

        const kt = extractFile("src/Service.kt", [
            "import com.acme.Repo as AcmeRepo",
            "open class Base",
            "class Service(val repo: AcmeRepo) : Base() {",
            "  companion object { fun create(): Service = Service(AcmeRepo()) }",
            "  fun save() { repo.flush() }",
            "}",
            "fun Service.ping() { save() }",
        ].join("\n"), "kotlin");
        assert.ok(kt.nodes.some((n) => n.name === "Companion" && n.kind === "class"));
        assert.ok(kt.nodes.some((n) => n.name === "repo" && n.kind === "field" && n.owner === "Service"));
        assert.ok(kt.nodes.some((n) => n.name === "ping" && n.owner === "Service"));
        assert.ok(kt.rawEdges.some((e) => e.relation === "extends" && e.name === "Base"));
        assert.ok(kt.rawEdges.some((e) => e.relation === "calls" && e.name === "flush" && e.recvType === "Repo"));

        const php = extractFile("app/Ctrl.php", [
            "<?php",
            "require_once __DIR__ . '/boot.php';",
            "class Ctrl extends BaseCtrl {",
            "  public function __construct(private Repo $repo) {}",
            "  public function handle() { $this->repo->save(); }",
            "}",
        ].join("\n"), "php");
        assert.ok(php.rawEdges.some((e) => e.relation === "imports" && e.specifier === "./boot.php"));
        assert.ok(php.rawEdges.some((e) => e.relation === "calls" && e.name === "save" && e.recvType === "Repo"));

        const r = extractFile("R/app.R", [
            "Svc <- R6::R6Class('Svc', public = list(run = function() {}))",
            "use_it <- function() { x <- Svc$new(); x$run() }",
        ].join("\n"), "r");
        assert.ok(r.rawEdges.some((e) => e.relation === "calls" && e.name === "run" && e.recvType === "Svc"));
    });

    await t.test("Containers: Vue/Svelte/Astro <template> markup extraction", () => {
        const vue = extractContainer("components/Page.vue", [
            "<template>",
            "  <UserCard @click=\"save\" />",
            "</template>",
            "<script setup lang=\"ts\">",
            "import UserCard from './UserCard.vue';",
            "function save() {}",
            "</script>",
        ].join("\n"), "vue");
        assert.ok(vue.nodes.some((n) => n.name === "save" && n.span === "L6-L6"), "preserves exact script span");
        assert.ok(vue.rawEdges.some((e) => e.relation === "references" && e.name === "UserCard" && e.specifier === "./UserCard.vue"));
        assert.ok(vue.rawEdges.some((e) => e.relation === "calls" && e.name === "save"));
    });

    await t.test("Generic 15 existing + 9 new WASM languages", () => {
        const samples = [
            ["c", "src/a.h", "int proto_fn(int x);"],
            ["cpp", "src/a.cpp", "class A : public Base { void f(); };\nvoid A::f() {}"],
            ["rust", "src/lib.rs", "pub use auth::login;\npub fn run() -> User { login() }"],
            ["c_sharp", "src/Svc.cs", "namespace App;\npublic class Svc : BaseSvc { private int id; public void Run() {} }"],
            ["scala", "src/App.scala", "import foo.{Bar => B}\nclass Svc extends Base { def run() = B() }"],
            ["elixir", "lib/app/user.ex", "defmodule App.User do\n  alias App.Repo, as: DB\n  defstruct [:id]\n  def get(), do: DB.find()\n  defp hidden(), do: :ok\nend"],
            ["dart", "lib/btn.dart", "import 'package:app/base.dart';\nclass Btn extends Base implements IBtn { void _priv() {} void tap() {} }"],
            ["ruby", "lib/user.rb", "class User < ActiveRecord::Base\n  include Loggable\n  attr_reader :email\n  private\n  def secret; end\nend"],
            ["solidity", "contracts/Token.sol", "import './ERC20.sol';\ncontract Token is ERC20 { constructor() {} function transfer() external {} }"],
            ["zig", "src/main.zig", 'const util = @import("./util.zig");\npub const Box = struct { pub fn init() void { util.ok(); } };'],
            ["clojure", "src/core.clj", "(ns app.core (:require [app.db :as db]))\n(defn run [] (db/save 1))"],
            ["nix", "default.nix", "let x = import (./sub.nix); in x"],
            ["lua", "init.lua", "local ok, mod = pcall(require, 'app.mod')\nfunction boot() end"],
            ["ocaml", "lib/a.ml", "open Utils\nlet run x = x"],
            ["ocaml_interface", "lib/a.mli", "val run : int -> int\ntype t = int"],
            ["bash", "scripts/deploy.sh", "source ./lib.sh\ndeploy() {\n  echo hi\n  helper\n}\ndeploy"],
            ["sql", "db/schema.sql", "CREATE TABLE users (id INT PRIMARY KEY);\nCREATE VIEW active_users AS SELECT * FROM users;\nCREATE TABLE orders (user_id INT REFERENCES users(id));"],
            ["hcl", "infra/main.tf", 'module "vpc" {\n  source = "./modules/vpc"\n}\nresource "aws_s3_bucket" "assets" {}\nvariable "env" {}\noutput "id" { value = "1" }'],
            ["proto", "api/user.proto", 'import "common.proto";\nmessage User { string id = 1; }\nservice UserService { rpc GetUser (User) returns (User); }'],
            ["graphql", "schema.graphql", "interface Node { id: ID! }\ntype User implements Node { id: ID! }\nfragment UserFields on User { id }"],
            ["objc", "ios/AppDelegate.m", '#import "AppDelegate.h"\n@interface AppDelegate : BaseDelegate <UIApp>\n- (void)start;\n@end\n@implementation AppDelegate\n- (void)start {}\n@end'],
            ["haskell", "src/Main.hs", "module Main where\nimport qualified App.Auth as A\ndata User = User Int\nmain :: IO ()\nmain = A.run"],
            ["gleam", "src/app.gleam", "import app/user\npub type Id { Id(Int) }\npub fn main() { user.find() }\nfn priv() { 1 }"],
            ["cuda", "kernels/vec.cu", '#include "vec.cuh"\nstruct Vec {};\n__global__ void add_vec(float *a) {}'],
        ];
        assert.equal(samples.length, 24);
        for (const [lang, file, code] of samples) {
            const res = extractGeneric(file, code, lang);
            assert.ok(res.nodes.length >= 2 || res.rawEdges.length >= 1, `${lang} (${file}) must extract nodes or edges`);
            assert.ok(languageOf(file) !== undefined || genericLangOfCheck(file), `${file} mapped`);
            assert.ok(languageLabelOf(file), `label for ${file}`);
        }
        assert.equal(extractGeneric("src/a.h", "int proto_fn(int x);", "c").nodes.find((n) => n.name === "proto_fn")?.declaration, true);
        assert.equal(extractGeneric("src/a.cpp", "class A {}; void A::f() {}", "cpp").nodes.find((n) => n.name === "f")?.owner, "A");
        assert.ok(extractGeneric("lib/a.ex", "defmodule App.U do\n  defstruct [:id]\n  def ok(), do: 1\n  defp p(), do: 2\nend", "elixir")
            .nodes.some((n) => n.name === "ok" && n.exported && n.owner === "App.U"));
        assert.equal(extractGeneric("lib/a.ex", "defmodule App.U do\n  defp p(), do: 2\nend", "elixir")
            .nodes.find((n) => n.name === "p")?.exported, false);
        assert.equal(extractGeneric("lib/a.dart", "void _p() {}", "dart").nodes.find((n) => n.name === "_p")?.exported, false);
        assert.equal(extractGeneric("contracts/T.sol", "contract T { constructor() {} function f() private {} }", "solidity")
            .nodes.find((n) => n.name === "f")?.exported, false);
        assert.ok(extractGeneric("contracts/T.sol", "contract T { constructor() {} }", "solidity")
            .nodes.some((n) => n.name === "constructor" && n.owner === "T"));
        assert.ok(extractGeneric("infra/m.tf", 'module "vpc" {\n  source = "./modules/vpc"\n}', "hcl")
            .rawEdges.some((e) => e.relation === "imports" && e.specifier === "./modules/vpc"));
        assert.ok(extractGeneric("schema.graphql", "interface Node { id: ID! }\ntype User implements Node { id: ID! }", "graphql")
            .rawEdges.some((e) => e.relation === "implements" && e.name === "Node"));
    });

    await t.test("End-to-end resolution: .h prototype preference, manifest resolvers, & 9 new languages", async () => {
        const tmp = mkdtempSync(join(tmpdir(), "plexer-36-"));
        try {
            mkdirSync(join(tmp, "scripts"), { recursive: true });
            mkdirSync(join(tmp, "infra/modules/vpc"), { recursive: true });
            mkdirSync(join(tmp, "api"), { recursive: true });
            mkdirSync(join(tmp, "crates/core/src"), { recursive: true });
            mkdirSync(join(tmp, "app/src"), { recursive: true });
            mkdirSync(join(tmp, "src"), { recursive: true });

            writeFileSync(join(tmp, "scripts/lib.sh"), "helper() {\n  echo ok\n}\n");
            writeFileSync(join(tmp, "scripts/deploy.sh"), "source ./lib.sh\nhelper\n");
            writeFileSync(join(tmp, "infra/main.tf"), 'module "vpc" {\n  source = "./modules/vpc"\n}\n');
            writeFileSync(join(tmp, "infra/modules/vpc/main.tf"), 'variable "cidr" {}\n');
            writeFileSync(join(tmp, "api/common.proto"), "message Empty {}\n");
            writeFileSync(join(tmp, "api/svc.proto"), 'import "common.proto";\nservice Svc { rpc Ping (Empty) returns (Empty); }\n');
            writeFileSync(join(tmp, "src/calc.h"), "int sum_vals(int a, int b);\n");
            writeFileSync(join(tmp, "src/calc.c"), "int sum_vals(int a, int b) { return a + b; }\n");
            writeFileSync(join(tmp, "src/main.c"), '#include "calc.h"\nint run() { return sum_vals(1, 2); }\n');
            writeFileSync(join(tmp, "crates/core/Cargo.toml"), '[package]\nname = "my-core"\n');
            writeFileSync(join(tmp, "crates/core/src/lib.rs"), "pub fn init_core() {}\n");
            writeFileSync(join(tmp, "app/src/main.rs"), "use my_core::init_core;\nfn main() { init_core(); }\n");

            const res = await buildGraph(tmp, { graphOnly: true, reuse: false });
            assert.equal(res.errors.length, 0, `unexpected build errors: ${res.errors.join("; ")}`);
            const graph = loadGraphCached(res.contextDir);
            const hasEdge = (src, rel, tgt) => graph.edges.some((e) => e.source === src && e.relation === rel && e.target === tgt);
            assert.ok(hasEdge("scripts/deploy.sh", "imports", "scripts/lib.sh"), "Bash source import resolves");
            assert.ok(hasEdge("infra/main.tf", "imports", "infra/modules/vpc/main.tf"), "HCL module source resolves");
            assert.ok(hasEdge("api/svc.proto", "imports", "api/common.proto"), "Proto import resolves");
            assert.ok(hasEdge("src/main.c#run", "calls", "src/calc.c#sum_vals"), "C call resolves to .c def instead of .h decl");
            assert.ok(hasEdge("app/src/main.rs", "imports", "crates/core/src/lib.rs"), "Rust Cargo.toml crate name import resolves");
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});

function genericLangOfCheck(f) {
    return /\.(?:sh|bash|zsh|sql|tf|tfvars|hcl|proto|graphql|gql|m|mm|hs|gleam|cu|cuh|ml|mli)$/i.test(f);
}
