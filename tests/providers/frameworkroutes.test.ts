import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGinReader } from "../../engine/providers/frameworkroutes/readers/gin.js";
import { createExpressReader } from "../../engine/providers/frameworkroutes/readers/express.js";
import { createVueRouterReader } from "../../engine/providers/frameworkroutes/readers/vuerouter.js";
import { createFrameworkRoutesProvider } from "../../engine/providers/frameworkroutes/provider.js";
import { joinRoutePath } from "../../engine/providers/frameworkroutes/readers/types.js";
import { sharedIndexRoot } from "../../engine/providers/codegraph/cli.js";

let workDir: string;

function write(relPath: string, content: string): void {
  const full = join(workDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function root(files: readonly string[]) {
  return { name: "svc", path: workDir, analyzedFiles: files };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-fwroutes-"));
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

const GO_MOD = "module example.com/svc\n\nrequire github.com/gin-gonic/gin v1.9.1\n";

describe("gin reader", () => {
  it("follows group chains to full paths, middleware, and handler identifiers", () => {
    // Verbatim shape from the real target's handlers.go.
    write("go.mod", GO_MOD);
    write(
      "handlers.go",
      `package handlers

func RouterRegistration(engine *gin.Engine) {
	v2 := engine.Group("/v2")
	leaveGrp := v2.Group("/leaves", auth.Authentication())
	{
		leaveGrp.POST("", e.CatchError(leave.Creation))
		leaveGrp.GET("/:leave_id", e.CatchError(leave.Demand))
		leaveGrp.GET("/me", e.CatchError(leave.OwnPagination))
	}
}
`,
    );

    const reading = createGinReader().read(root(["go.mod", "handlers.go"]));
    expect(reading.failures).toEqual([]);
    expect(reading.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v2/leaves",
      "GET /v2/leaves/:leave_id",
      "GET /v2/leaves/me",
    ]);
    expect(reading.routes[0]).toMatchObject({
      handlerName: "leave.Creation",
      middleware: ["auth.Authentication"],
    });
    expect(reading.routes[0]!.provenance.resolutionClass).toBe("resolved");
  });

  it("roots a chain at an engine exposed as a struct field — the split-registration case", () => {
    write("go.mod", GO_MOD);
    write(
      "main.go",
      `package main

func main() {
	engine := svReg.Gin
	engine.Any("/health", func(ctx *gin.Context) {
		ctx.JSON(200, gin.H{"msg": "ok"})
	})
}
`,
    );

    const reading = createGinReader().read(root(["go.mod", "main.go"]));
    expect(reading.routes).toHaveLength(1);
    expect(reading.routes[0]).toMatchObject({ method: null, path: "/health", handlerName: null });
  });

  it("joins a subpath with no leading slash, which Gin accepts", () => {
    write("go.mod", GO_MOD);
    write(
      "r.go",
      `package r
func Reg(engine *gin.Engine) {
	ot := engine.Group("/ot")
	ot.GET("count", e.CatchError(x.GetCount))
}
`,
    );

    const reading = createGinReader().read(root(["go.mod", "r.go"]));
    expect(reading.routes[0]!.path).toBe("/ot/count");
  });

  it("does not mistake a logger's Any call for a route", () => {
    // zap.Any("key", value) matches the method name but is not a registration.
    write("go.mod", GO_MOD);
    write(
      "log.go",
      `package l
func L() {
	logger.Info("x", zap.Any("key", value))
}
`,
    );

    const reading = createGinReader().read(root(["go.mod", "log.go"]));
    expect(reading.routes).toEqual([]);
    expect(reading.failures).toEqual([]);
  });

  it("records a chain it cannot follow as a failure, never a guessed path", () => {
    write("go.mod", GO_MOD);
    write(
      "orphan.go",
      `package o
func Reg() {
	mystery.GET("/things", handler)
}
`,
    );

    const reading = createGinReader().read(root(["go.mod", "orphan.go"]));
    expect(reading.routes).toEqual([]);
    expect(reading.failures).toHaveLength(1);
    expect(reading.failures[0]!.reason).toContain("mystery");
  });

  it("marks a RouterGroup parameter's routes as incomplete rather than asserting them", () => {
    write("go.mod", GO_MOD);
    write(
      "sub.go",
      `package s
func Reg(grp *gin.RouterGroup) {
	grp.GET("/items", e.CatchError(x.List))
}
`,
    );

    const reading = createGinReader().read(root(["go.mod", "sub.go"]));
    expect(reading.routes[0]!.provenance.resolutionClass).toBe("inferred");
    expect(reading.failures[0]!.reason).toContain("prefix");
  });

  it("keeps both readings of a wrapped registration", () => {
    // ginSwagger.WrapHandler(swaggerFiles.Handler) is the wrapper doing the
    // work; e.CatchError(leave.Creation) is the inner function doing it. The
    // registration cannot tell them apart, so both names survive to the
    // symbol join.
    write("go.mod", GO_MOD);
    write(
      "r.go",
      `package r
func Reg(e *gin.Engine) {
	e.GET("/a", e.CatchError(leave.Creation))
	e.GET("/b", ginSwagger.WrapHandler(swaggerFiles.Handler))
	e.GET("/c", oauth.AuthorizeEntry)
	e.GET("/d", func(ctx *gin.Context) {})
}
`,
    );

    const reading = createGinReader().read(root(["go.mod", "r.go"]));
    const candidates = Object.fromEntries(
      reading.routes.map((route) => [route.path, route.handlerCandidates]),
    );

    expect(candidates["/a"]).toEqual(["leave.Creation", "e.CatchError"]);
    expect(candidates["/b"]).toEqual(["swaggerFiles.Handler", "ginSwagger.WrapHandler"]);
    expect(candidates["/c"]).toEqual(["oauth.AuthorizeEntry"]);
    expect(candidates["/d"]).toEqual([]);
  });

  it("normalizes an imported package alias before handler linking", () => {
    write("go.mod", GO_MOD);
    write(
      "r.go",
      `package r
import (
  aplyGeneral "example.com/svc/internal/handlers/application/general"
  e "example.com/svc/internal/pkg/error"
  "github.com/gin-gonic/gin"
)
func Reg(engine *gin.Engine) {
  engine.GET("/applications", e.CatchError(aplyGeneral.Pagination))
}
`,
    );

    const reading = createGinReader().read(root(["go.mod", "r.go"]));
    expect(reading.routes[0]!.handlerCandidates).toEqual([
      "aplyGeneral.Pagination",
      "general.Pagination",
      "e.CatchError",
      "error.CatchError",
    ]);
  });

  it("does not detect a Go project without gin", () => {
    write("go.mod", "module x\n\nrequire github.com/pkg/errors v0.9.1\n");
    expect(createGinReader().detect(root(["go.mod"]))).toBe(false);
  });
});

const PACKAGE_JSON = JSON.stringify({ dependencies: { express: "^4.18.0" } });

describe("express reader", () => {
  it("resolves mounts and parses multi-line registrations with middleware", () => {
    // Verbatim shape from the real target's app.js + routes/worklogs.js.
    write("package.json", PACKAGE_JSON);
    write(
      "app.js",
      `const worklogsRouter = require('./routes/worklogs')(passport);
app.use('/worklogs', worklogsRouter);
`,
    );
    write(
      "routes/worklogs.js",
      `const router = express.Router();
router.get(
  '/me/worklogs',
  validate([ query('start_date').isString() ]),
  passport.authenticate('jwt', { session: false }),
  wrapAsync(async (req, res, next) => {
    const logs = await worklogService.getWorkLogsByUser(req);
    res.json({ logs: logs });
  })
);
`,
    );

    const reading = createExpressReader().read(
      root(["package.json", "app.js", "routes/worklogs.js"]),
    );

    expect(reading.routes).toHaveLength(1);
    expect(reading.routes[0]).toMatchObject({
      method: "GET",
      path: "/worklogs/me/worklogs",
      handlerName: "worklogService.getWorkLogsByUser",
    });
    expect(reading.routes[0]!.middleware).toContain("passport.authenticate");
    expect(reading.routes[0]!.provenance.resolutionClass).toBe("resolved");
  });

  it("keeps an unmounted route file's paths at low confidence with the reason recorded", () => {
    write("package.json", PACKAGE_JSON);
    write(
      "routes/orphan.js",
      `const router = express.Router();
router.get('/things', handler);
`,
    );

    const reading = createExpressReader().read(root(["package.json", "routes/orphan.js"]));
    expect(reading.routes[0]!.provenance.resolutionClass).toBe("inferred");
    expect(reading.failures[0]!.reason).toContain("mount");
  });

  it("resolves an inline require mount", () => {
    write("package.json", PACKAGE_JSON);
    write("app.js", `app.use('/leaves', require('./routes/leave')(passport));\n`);
    write(
      "routes/leave.js",
      `const router = express.Router();
router.get('/leave/types', wrapAsync(async (req, res) => {
  const t = await leaveService.getTypes(req);
}));
`,
    );

    const reading = createExpressReader().read(root(["package.json", "app.js", "routes/leave.js"]));
    expect(reading.routes[0]!.path).toBe("/leaves/leave/types");
    expect(reading.routes[0]!.handlerName).toBe("leaveService.getTypes");
  });

  it("mounts a route file by whole-word identifier, not a substring of another", () => {
    // Unanchored, "logRouter" matches inside "catalogRouter = require(...)"
    // and mounts the wrong file — publishing endpoints that do not exist.
    write("package.json", PACKAGE_JSON);
    write(
      "app.js",
      `const catalogRouter = require('./routes/catalog');
const logRouter = require('./routes/log');
app.use('/catalog', catalogRouter);
app.use('/logs', logRouter);
`,
    );
    write("routes/catalog.js", "const router = express.Router();\nrouter.get('/items', h);\n");
    write("routes/log.js", "const router = express.Router();\nrouter.get('/recent', h);\n");

    const reading = createExpressReader().read(
      root(["package.json", "app.js", "routes/catalog.js", "routes/log.js"]),
    );

    expect(reading.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "GET /catalog/items",
      "GET /logs/recent",
    ]);
    expect(reading.failures).toEqual([]);
  });

  it("reads routes registered on the application object with their full path", () => {
    // Verbatim shape from the real target's index.js: const app = express();
    // app.get('/api/products', getProducts) — no express.Router() anywhere.
    write("package.json", PACKAGE_JSON);
    write(
      "index.js",
      `const app = express();
app.use(cors());
app.get('/api/products', getProducts);
app.post('/api/login', loginLimiter, login);
app.get('/', (req, res) => { res.send('ok'); });
`,
    );

    const reading = createExpressReader().read(root(["package.json", "index.js"]));

    expect(reading.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "GET /",
      "GET /api/products",
      "POST /api/login",
    ]);
    const products = reading.routes.find((r) => r.path === "/api/products")!;
    expect(products.handlerName).toBe("getProducts");
    expect(products.provenance.resolutionClass).toBe("resolved");
    const login = reading.routes.find((r) => r.path === "/api/login")!;
    expect(login.handlerName).toBe("login");
    expect(login.middleware).toEqual(["loginLimiter"]);
    expect(reading.failures).toEqual([]);
  });

  it("records an app-object registration with a non-literal path as a failure, not a guess", () => {
    write("package.json", PACKAGE_JSON);
    write("index.js", "const app = express();\napp.get('/api/' + resource, handler);\n");

    const reading = createExpressReader().read(root(["package.json", "index.js"]));
    expect(reading.routes).toEqual([]);
    expect(reading.failures[0]!.reason).toContain("string literal");
  });

  it("reads app-object routes and router mounts together, without duplication", () => {
    write("package.json", PACKAGE_JSON);
    write(
      "index.js",
      `const app = express();
app.get('/api/ping', ping);
app.use('/leaves', require('./routes/leave')(passport));
`,
    );
    write("routes/leave.js", "const router = express.Router();\nrouter.get('/types', h);\n");

    const reading = createExpressReader().read(
      root(["package.json", "index.js", "routes/leave.js"]),
    );
    expect(reading.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "GET /api/ping",
      "GET /leaves/types",
    ]);
    expect(reading.failures).toEqual([]);
  });

  it("invents no route from app-wide middleware or a listen call", () => {
    write("package.json", PACKAGE_JSON);
    write(
      "index.js",
      `const app = express();
app.use(cors());
app.use(express.json());
app.listen(3000);
`,
    );

    const reading = createExpressReader().read(root(["package.json", "index.js"]));
    expect(reading.routes).toEqual([]);
    expect(reading.failures).toEqual([]);
  });

  it("does not detect a node project without express", () => {
    write("package.json", JSON.stringify({ dependencies: { vue: "^3.0.0" } }));
    expect(createExpressReader().detect(root(["package.json"]))).toBe(false);
  });
});

const VUE_PACKAGE_JSON = JSON.stringify({ dependencies: { "vue-router": "^4.0.0" } });

describe("vue-router reader", () => {
  it("reads the createRouter table as client routes with their component", () => {
    // Verbatim shape from the real target's src/router/index.js.
    write("package.json", VUE_PACKAGE_JSON);
    write(
      "src/router/index.js",
      `import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: HomeView, meta: { title: 'Home' } },
    { path: '/product/:id', name: 'product', component: () => import('../views/ProductView.vue') },
    { path: '/checkout', name: 'checkout', component: () => import('../views/CheckoutView.vue') },
  ],
})
`,
    );

    const reading = createVueRouterReader().read(root(["package.json", "src/router/index.js"]));

    expect(reading.routes.map((r) => r.path).sort()).toEqual(["/", "/checkout", "/product/:id"]);
    expect(reading.routes.every((r) => r.surface === "client" && r.method === null)).toBe(true);
    expect(reading.routes.find((r) => r.path === "/")!.handlerName).toBe("HomeView");
    // A lazily imported component names no symbol here.
    expect(reading.routes.find((r) => r.path === "/product/:id")!.handlerName).toBeNull();
    expect(reading.failures).toEqual([]);
  });

  it("composes nested children under the parent path", () => {
    write("package.json", VUE_PACKAGE_JSON);
    write(
      "src/router/index.ts",
      `import { createRouter } from 'vue-router'
const router = createRouter({
  routes: [
    { path: '/user', component: UserLayout, children: [
      { path: 'profile', component: Profile },
      { path: 'settings', component: Settings },
    ] },
  ],
})
`,
    );

    const reading = createVueRouterReader().read(root(["package.json", "src/router/index.ts"]));
    expect(reading.routes.map((r) => r.path).sort()).toEqual([
      "/user",
      "/user/profile",
      "/user/settings",
    ]);
  });

  it("records a runtime-assembled path as a failure, never a guess", () => {
    write("package.json", VUE_PACKAGE_JSON);
    write(
      "src/router/index.js",
      `import { createRouter } from 'vue-router'
const base = '/x'
const router = createRouter({ routes: [ { path: base + '/y', component: C } ] })
`,
    );

    const reading = createVueRouterReader().read(root(["package.json", "src/router/index.js"]));
    expect(reading.routes).toEqual([]);
    expect(reading.failures[0]!.reason).toContain("string literal");
  });

  it("does not read a plain object that merely has a path key", () => {
    write("package.json", VUE_PACKAGE_JSON);
    write(
      "src/router/index.js",
      `import { createRouter } from 'vue-router'
const fileConfig = { path: '/some/asset/path' }
const router = createRouter({ routes: [ { path: '/home', component: Home } ] })
`,
    );

    const reading = createVueRouterReader().read(root(["package.json", "src/router/index.js"]));
    expect(reading.routes.map((r) => r.path)).toEqual(["/home"]);
  });

  it("does not detect a node project without vue-router", () => {
    write("package.json", JSON.stringify({ dependencies: { react: "^18.0.0" } }));
    expect(createVueRouterReader().detect(root(["package.json"]))).toBe(false);
  });
});

describe("the provider", () => {
  it("declares a gap for a root no reader recognizes, never silence", () => {
    write("main.py", "print('hi')");
    const contribution = createFrameworkRoutesProvider().extract(root(["main.py"]));

    expect(contribution.records.route).toEqual([]);
    expect(contribution.gaps).toHaveLength(1);
    expect(contribution.gaps[0]!.reason).toContain("no supported web framework");
  });

  it("emits routes from the reader that detects the root", () => {
    write("go.mod", GO_MOD);
    write(
      "r.go",
      `package r
func Reg(engine *gin.Engine) {
	engine.GET("/ping", e.CatchError(x.Ping))
}
`,
    );

    const contribution = createFrameworkRoutesProvider().extract(root(["go.mod", "r.go"]));
    expect(contribution.records.route).toHaveLength(1);
    expect(contribution.gaps).toEqual([]);
  });
});

describe("joinRoutePath", () => {
  it("joins and normalizes", () => {
    expect(joinRoutePath("/v2/leaves", "")).toBe("/v2/leaves");
    expect(joinRoutePath("/v2", "/leaves")).toBe("/v2/leaves");
    expect(joinRoutePath("/ot", "count")).toBe("/ot/count");
    expect(joinRoutePath("", "/health")).toBe("/health");
    expect(joinRoutePath("", "")).toBe("/");
  });
});

describe("sharedIndexRoot", () => {
  it("finds the directory holding every root", () => {
    expect(sharedIndexRoot(["/w/api", "/w/ui", "/w/worker"])).toBe("/w");
  });

  it("refuses when the roots do not share one", () => {
    expect(sharedIndexRoot(["/a/api", "/b/ui"])).toBeNull();
  });

  it("refuses when a root is itself the shared parent", () => {
    // Indexing there would index the sibling roots twice, once nested.
    expect(sharedIndexRoot(["/w", "/w/ui"])).toBeNull();
  });

  it("puts a single root's index beside it, not inside it", () => {
    // The read-only guarantee toward analyzed source cannot hold only for
    // workspaces that happen to have more than one part.
    expect(sharedIndexRoot(["/w/api"])).toBe("/w");
  });

  it("refuses a root directly under the filesystem root", () => {
    expect(sharedIndexRoot(["/api"])).toBeNull();
  });

  it("refuses the filesystem root, which would walk the disk", () => {
    expect(sharedIndexRoot(["/api", "/ui"])).toBeNull();
  });
});
