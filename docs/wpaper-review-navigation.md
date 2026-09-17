# Review navigation owns the viewport

Jumping to a review hunk temporarily suspends cursor-driven page navigation.
Render refreshes, delayed tracing callbacks and unchanged editor selections do
not reclaim the viewport. Closing the review does not jump back either.

A changed selection from a keyboard, mouse or command gesture in the active TeX
editor restores ordinary following, respecting the user's existing follow mode.
Unattributed selection shifts (for example from external edits) do not do so.
Moving the cursor also cancels a pending review jump waiting for a new PDF.

The host records navigation ownership and the client checks it again after
asynchronous rendering. Navigation epochs prevent a late cursor render, an older
review jump or an in-flight PDF open from undoing a newer navigation decision.
Switching papers clears review ownership.
