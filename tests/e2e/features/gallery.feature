@basic
Feature: Gallery Loading
  Test basic gallery page loading

  Scenario: Gallery loads with images
    When I go to the basic gallery with "5" "medium" images
    Then I should see "5" images loaded

  Scenario: Icon-sized images are not processed
    When I go to the basic gallery with "5" "icon" images
    Then I should see "5" images loaded
    And I should see "0" mask overlays
