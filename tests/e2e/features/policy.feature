@policy
Feature: Site Policy
  Test whitelist, blacklist, and process policies

  @whitelist
  Scenario: Whitelist policy skips processing
    Given I set the global policy to "whitelist"
    When I go to the "not-safe" basic gallery with "1" "medium" images
    Then I should see "0" mask overlays

  @blacklist
  Scenario: Blacklist policy masks all images
    Given I set the global policy to "blacklist"
    When I go to the "safe" basic gallery with "1" "medium" images
    Then all images should be blacklisted

  @process
  Scenario: Process policy uses AI detection
    Given I set the global policy to "process"
    When I go to the "not-safe" basic gallery with "1" "medium" images
    Then I should see at least "1" segment mask overlays with canvas
