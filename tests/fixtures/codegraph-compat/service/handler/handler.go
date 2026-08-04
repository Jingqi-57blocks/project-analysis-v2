package handler

// Store is referenced from main, which gives the index a reference edge to find.
type Store struct {
	Entries []string
}

func NewStore() *Store {
	return &Store{Entries: []string{}}
}

// Handle is called from main, which gives the index a call edge to find.
func Handle(s *Store, message string) string {
	s.Entries = append(s.Entries, message)
	return format(message)
}

func format(message string) string {
	return "handled: " + message
}
