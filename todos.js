const config = require("./lib/config");
const express = require("express");
const morgan = require("morgan");
const flash = require("express-flash"); //requires express-session to render message
// const JSONPersistence = require("./lib/json-persistence");
const catchError = require("./lib/catch-error");

//generates unique session ID whenever client browser makes initial HTTP request to app
const session = require("express-session"); //provides support for persisting data over multiple req/res cycles
const { body, validationResult } = require("express-validator");
const store = require("connect-loki"); //lets express-session use a NoSQL database as session data store
const SessionPersistence = require("./lib/session-persistance");
const PgPersistance = require("./lib/pg-persistance");
const app = express();
const host = config.HOST;
const port = config.PORT;
const LokiStore = store(session);

app.set("views", "./views");
app.set("view engine", "pug");

app.use(morgan("common"));
app.use(express.static("public"));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  cookie: {
    httpOnly: true,
    maxAge: 31 * 24 * 60 * 60 * 1000, // 31 days in millseconds
    path: "/",
    secure: false,
  },
  name: "launch-school-todos-session-id",
  resave: false,
  saveUninitialized: true,
  secret: config.SECRET,
  store: new LokiStore({}),
}));

app.use(flash());

// Create a new datastore
// Middleware will be executed for every request to the app since path defaults to "/"
app.use((req, res, next) => {
  //res locals object used by view engines to render responses
  //variables set on res.locals are available within a single req/res cycle
  //constructor needs access to req.session so that it can access persisted data
  res.locals.store = new PgPersistance(req.session);  
  next();
});
 
// Extract session info
// Middleware will be executed for every request to the app since path defaults to "/"
app.use((req, res, next) => {
  res.locals.flash = req.session.flash;
  delete req.session.flash;
  next();
});

//Ensure every view temnplate receives signedIn a nd username variables from the session store
app.use((req, res, next) => {
  res.locals.username = req.session.username;
  res.locals.signedIn = req.session.signedIn;
  res.locals.flash = req.session.flash;
  delete req.session.flash;
  next();
})

// Detect unauthorized access to routes.
const requiresAuthentication = (req, res, next) => {
  if (!res.locals.signedIn) {
    console.log("Unauthorized.");
    res.redirect(302, "/users/signin");
  } else {
    next();
  }
};


// Redirect start page
app.get("/", (req, res) => {
  res.redirect("/lists");
});

// Render the list of todo lists
app.get("/lists", 
  requiresAuthentication,
  catchError(async (req, res) => {
    let store = res.locals.store; //new Session Persistance object
    let todoLists = await store.sortedTodoLists();
    let todosInfo = todoLists.map(todoList => ({
      countAllTodos: todoList.todos.length,
      countDoneTodos: todoList.todos.filter(todo => todo.done).length,
      isDone: store.isDoneTodoList(todoList),
    }));
  
    res.render("lists", {
      todoLists,
      todosInfo,
    });
  })
);

//Sign in 
app.get("/users/signin", (req, res) => {
  req.flash("info", "Please sign in.");
  res.render("signin", {
    flash: req.flash(),
  });
});

//submit sign-in
app.post("/users/signin", 
  catchError(async (req, res) => {
    let username = req.body.username.trim();
    let password = req.body.password;

    let authenticated = await res.locals.store.authenticate(username, password);

    if (!authenticated) {
      req.flash("error", "Invalid credentials.");
      res.render("signin", {
        flash: req.flash(),
        username: req.body.username,
      })
    } else {
      let session = req.session;
      session.username = username;
      session.signedIn = true;
      req.flash("info", "Welcome!");
      res.redirect("/lists");
    }
  })
);



// Render new todo list page
app.get("/lists/new", 
  requiresAuthentication,
  (req, res) => {
  res.render("new-list");
});

// Create a new todo list
app.post("/lists",
  requiresAuthentication,
  [
    body("todoListTitle")
      .trim()
      .isLength({ min: 1 })
      .withMessage("The list title is required.")
      .isLength({ max: 100 })
  ],
  catchError(async (req, res) => {
    let errors = validationResult(req);
    let todoListTitle = req.body.todoListTitle;
    const rerenderNewList = () => {
      res.render("new-list", {
        todoListTitle,
        flash: req.flash()
      })
    };

    if (!errors.isEmpty()) {
      errors.array().forEach(message => req.flash("error", message.msg));
      rerenderNewList();
    } else if (await res.locals.store.existsTodoListTitle(todoListTitle)) {
      req.flash("error", "The list title must be unique.");
      rerenderNewList();
    } else {
      let created = await res.locals.store.createTodoList(todoListTitle);
      if (!created) {
        req.flash("error", "The list title must be unique.");
        rerenderNewList();
    } else {
      req.flash("success", "The todo list has been created.");
      res.redirect("/lists");
    }
    }
  })
);

// Render individual todo list and its todos
app.get("/lists/:todoListId", 
  requiresAuthentication,
  catchError(async (req, res) => {
    let todoListId = req.params.todoListId; //req.params is an object containing properties mapped to the named route params
    let todoList = await res.locals.store.loadTodoList(+todoListId);
    if (todoList === undefined) {
      throw new Error("Not found.");
    } 

    todoList.todos = await res.locals.store.sortedTodos(todoList);

    //renders a view and sends rendered HTML string to the client 
    //parameter includes 'locals' an object whose propertures define local variables for the view
    res.render("list", {
      todoList,
      isDoneTodoList: res.locals.store.isDoneTodoList(todoList),
      hasUndoneTodos: res.locals.store.hasUndoneTodos(todoList),
    });
    
  })
);

// Toggle completion status of a todo
app.post("/lists/:todoListId/todos/:todoId/toggle", 
  requiresAuthentication,
  catchError(async (req, res) => {
    let { todoListId, todoId } = req.params;
    let toggled = await res.locals.store.toggleDoneTodo(+todoListId, +todoId);
    if (!toggled) throw new Error("Not found.");
    
    let todo = await res.locals.store.loadTodo(+todoListId, +todoId);
    if (!todo.done) {
      req.flash("success", `"${todo.title}" marked as NOT done!`);
    } else {
      req.flash("success", `"${todo.title}" marked done.`);
    }

    res.redirect(`/lists/${todoListId}`);
  })
);

// Delete a todo
app.post("/lists/:todoListId/todos/:todoId/destroy", 
  requiresAuthentication,
  catchError(async (req, res) => {
    let { todoListId, todoId } = req.params;

    let deleted = await res.locals.store.deleteTodo(+todoListId, +todoId);

    if (!deleted) throw new Error("Not found.");
    
    req.flash("success", "The todo has been deleted.");
    res.redirect(`/lists/${todoListId}`);
    })
);

// Mark all todos as done
app.post("/lists/:todoListId/complete_all", 
  requiresAuthentication,
  catchError(async (req, res) => {
    let todoListId = req.params.todoListId;

    let completed = await res.locals.store.completeAll(+todoListId);

    if (!completed) throw new Error("Not found.");
    
    req.flash("success", "All todos have been marked as done.");
    res.redirect(`/lists/${todoListId}`);
  })
);

// Create a new todo and add it to the specified list
app.post("/lists/:todoListId/todos",

  requiresAuthentication,
  [
    body("todoTitle")
      .trim()
      .isLength({ min: 1 })
      .withMessage("The todo title is required.")
      .isLength({ max: 100 })
      .withMessage("Todo title must be between 1 and 100 characters."),
  ],
  catchError(async (req, res) => {
    let todoListId = req.params.todoListId;
    let todoTitle = req.body.todoTitle;
           
    let errors = validationResult(req);
    if (!errors.isEmpty()) {
      errors.array().forEach(message => req.flash("error", message.msg));

      let todoList = await res.locals.store.loadTodoList(+todoListId);
      if (!todoList) throw new Error("Not found.");

      todoList.todos = await res.locals.store.sortedTodos(todoList);

      res.render("list", {
        flash: req.flash(),
        todoList,
        isDoneTodoList: res.locals.store.isDoneTodoList(todoList),
        hasUndoneTodos: res.locals.store.hasUndoneTodos(todoList).
        todoTitle,
      });
    } else {
      let created = await res.locals.store.createTodo(+todoListId, todoTitle);
      if (!created) throw new Error("Not found.");
      
      req.flash("success", "The todo has been created.");
      res.redirect(`/lists/${todoListId}`);
    }
  })
);

// Render edit todo list form
app.get("/lists/:todoListId/edit", 
  requiresAuthentication,
  catchError(async(req, res) => {
    let todoListId = req.params.todoListId;
    let todoList = await res.locals.store.loadTodoList(+todoListId);
    if (!todoList) throw new Error("Not found.");
      
    res.render("edit-list", { todoList });
  })
);

// Delete todo list
app.post("/lists/:todoListId/destroy", 
  requiresAuthentication,
  catchError(async(req, res) => {
    let todoListId = +req.params.todoListId;
    let deleted = await res.locals.store.deleteTodoList(+todoListId);

    if (!deleted) throw new Error("Not found.");
    
    req.flash("success", "The todo list has been deleted.");
    res.redirect(`/lists`);
      
  })  
);

// Edit todo list title
app.post("/lists/:todoListId/edit",

  requiresAuthentication,
  [
    body("todoListTitle")
      .trim()
      .isLength({ min: 1 })
      .withMessage("The list title is required.")
      .isLength({ max: 100 })
  ],
  catchError(async (req, res) => {
    let store = res.locals.store;
    let todoListId = req.params.todoListId;
    let todoListTitle = req.body.todoListTitle;

    const rerenderEditList = async () => {
      let todoList = store.loadTodoList(+todoListId);
      if (!todoList) throw new Error("Not found.");

      res.render("edit-list", {
        todoListTitle,
        todoList,
        flash: req.flash(),
      });
    }
    
    try {
      let errors = validationResult(req);
      if (!errors.isEmpty()) {
        errors.array().forEach(message => req.flash("error", message.msg));
        rerenderEditList();
      } else if (await store.existsTodoListTitle(todoListTitle)) {
        req.flash("error", "The list title must be unique.");
        rerenderEditList();
      } else {
        let updated = await store.setTodoListTitle(+todoListId, todoListTitle);
        if (!updated) throw new Error("Not found.");

        req.flash("success", "Todo list updated.");
        res.redirect(`/lists/${todoListId}`);
      }
    } catch (error) {
      if (store.isUniqueConstraintViolation(error)) {
        req.flash("error", "The list title must be unique.");
        rerenderEditList();
      } else {
        throw error;
      }
    }
  })
);

//Sign out
app.post("/users/signout", (req, res) => {
  delete req.session.signedIn;
  delete req.session.username;
  res.redirect("/users/signin");
})

// Error handler
app.use((err, req, res, _next) => {
  console.log(err); // Writes more extensive information to the console log
  res.status(404).send(err.message);
});

// Listener
app.listen(port, host, () => {
  console.log(`Todos is listening on port ${port} of ${host}!`);
});
