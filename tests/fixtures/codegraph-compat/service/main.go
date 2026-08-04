package main

import "compat/service/handler"

func main() {
	store := handler.NewStore()
	handler.Handle(store, "ping")
}
