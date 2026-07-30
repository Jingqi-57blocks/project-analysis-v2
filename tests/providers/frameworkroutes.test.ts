import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGinReader } from "../../engine/providers/frameworkroutes/readers/gin.js";
import { createExpressReader } from "../../engine/providers/frameworkroutes/readers/express.js";
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

  it("does not detect a node project without express", () => {
    write("package.json", JSON.stringify({ dependencies: { vue: "^3.0.0" } }));
    expect(createExpressReader().detect(root(["package.json"]))).toBe(false);
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
    expect(sharedIndexRoot(["/w/api", "/w/ui", "/w/worker"]).path).toBe("/w");
  });

  it("puts a single root's index beside it, not inside it", () => {
    // The read-only guarantee toward analyzed source cannot hold only for
    // workspaces that happen to have more than one part.
    expect(sharedIndexRoot(["/w/api"]).path).toBe("/w");
  });

  it("says why, rather than only that it refused", () => {
    // The reason is persisted as the gap for every kind the provider would have
    // supplied, so a generic one sends a reader after a problem they do not
    // have. It once told users to analyze from a directory containing the root
    // when that is exactly what they had done.
    // Roots on different top-level directories share only the filesystem root,
    // so that is the honest reason rather than "they share none".
    expect(sharedIndexRoot(["/a/api", "/b/ui"]).refusal).toContain("filesystem root");
    expect(sharedIndexRoot([]).refusal).toContain("no roots were named");
    expect(sharedIndexRoot(["/w", "/w/ui"]).refusal).toContain("inside analyzed source");
    expect(sharedIndexRoot(["/api", "/ui"]).refusal).toContain("filesystem root");
    expect(sharedIndexRoot(["/api"]).refusal).toContain("filesystem root");
  });

  describe("directories too broad to index", () => {
    const realHome = process.env.HOME;
    afterEach(() => {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    });

    it("refuses a home directory, which a repository sitting in it would choose", () => {
      process.env.HOME = workDir;
      const choice = sharedIndexRoot([join(workDir, "proj")]);
      expect(choice.path).toBeUndefined();
      expect(choice.refusal).toContain("home directory");
    });

    it("refuses a directory above a home directory, which is worse still", () => {
      // `~` itself as the only root puts the parent at /Users, holding every
      // account on the machine. The guard that only compared against home let
      // this through.
      process.env.HOME = join(workDir, "me");
      const choice = sharedIndexRoot([join(workDir, "me")]);
      expect(choice.path).toBeUndefined();
      expect(choice.refusal).toContain("above it");
    });

    it("sees through a symlinked home directory", () => {
      // resolve() is not realpath(), and a symlinked HOME is ordinary. The same
      // lexical-versus-canonical split sank an earlier attempt at this.
      const real = join(workDir, "real");
      mkdirSync(join(real, "me"), { recursive: true });
      symlinkSync(join(real, "me"), join(workDir, "link"));
      process.env.HOME = join(workDir, "link");

      const choice = sharedIndexRoot([join(real, "me", "proj")]);
      expect(choice.path).toBeUndefined();
      expect(choice.refusal).toContain("home directory");
    });

    it("allows a directory two levels below home, which is an ordinary workspace", () => {
      process.env.HOME = workDir;
      expect(sharedIndexRoot([join(workDir, "dev", "proj")]).path).toBe(join(workDir, "dev"));
    });
  });
});
