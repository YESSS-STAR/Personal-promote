// Creates an observer that watches for elements scrolling into view
const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
        // If the element is visible on the screen
        if (entry.isIntersecting) {
            // Add the 'show' class to trigger the CSS transition
            entry.target.classList.add('show');
            
            // Optional: stop observing once it has appeared so it doesn't animate again
            observer.unobserve(entry.target);
        }
    });
}, {
    // Triggers the animation slightly before the element is fully visible
    threshold: 0.1,
    rootMargin: "0px 0px -50px 0px"
});

// Grab all elements with the 'hidden' class and watch them
const hiddenElements = document.querySelectorAll('.hidden');
hiddenElements.forEach((el) => observer.observe(el));
