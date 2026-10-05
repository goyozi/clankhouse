Two reviewers reviewed the uncommitted changes against these requirements.

<requirements>
{{requirements}}
</requirements>

<review-1>
{{review1}}
</review-1>

<review-2>
{{review2}}
</review-2>

Verify each finding against the code and de-duplicate them. Act on findings a strong engineer would fix before merging,
skip matters of taste and risks too unlikely to be worth the complexity a fix would add. When the reviews suggest a
simpler approach that meets the requirements, prefer it.

Answer with:

- `act`: the findings worth fixing, most important first, each with a reason; leave it empty if there is nothing to act
  on;
- `skip`: the findings not worth fixing, each with a reason;
- `anotherReviewNeeded`: whether the fixes are big or risky enough to warrant another review

Make each finding self-contained: someone who hasn't seen the reviews should be able to understand it.

Don't change any files.
