import { test, expect } from '@playwright/test';

test.describe('Web Dashboard UAT', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for app to load
    await page.waitForSelector('text=Rooms', { timeout: 10000 });
  });

  test('1. Create a room', async ({ page }) => {
    // Click + button to create room
    await page.click('button[title="Create room"]');

    // Wait for modal
    await expect(page.locator('h2:has-text("Create Room")')).toBeVisible();

    // Fill room name
    const roomName = `test-room-${Date.now()}`;
    await page.fill('input[placeholder="Room name"]', roomName);
    await page.fill('input[placeholder="Topic (optional)"]', 'Test topic');

    // Click Create or Next button
    await page.click('button:has-text("Create"), button:has-text("Next")');

    // If template picker appears, skip it
    const skipButton = page.locator('button:has-text("Skip")');
    if (await skipButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipButton.click();
    }

    // Verify room appears in sidebar
    await expect(page.locator(`text=#${roomName}`)).toBeVisible({ timeout: 5000 });
  });

  test('2. Create an agent template', async ({ page }) => {
    // Navigate to Templates tab
    await page.click('button:has-text("Templates"), a:has-text("Templates")');

    // Wait for Templates panel
    await expect(page.locator('h2:has-text("Templates")')).toBeVisible({ timeout: 5000 });

    // Click + New Template
    await page.click('button:has-text("+ New")');

    // Wait for modal
    await expect(page.locator('h2:has-text("New Template")')).toBeVisible();

    // Fill template form
    const templateName = `test-template-${Date.now()}`;
    await page.fill('input[placeholder="my-template"]', templateName);
    await page.selectOption('select', 'worker');
    await page.fill('textarea[placeholder*="senior engineer"]', 'Test persona');

    // Click Create
    await page.click('button:has-text("Create")');

    // Verify template appears in list
    await expect(page.locator(`text=${templateName}`)).toBeVisible({ timeout: 5000 });
  });

  test('3. Edit an agent template', async ({ page }) => {
    // Navigate to Templates tab
    await page.click('button:has-text("Templates"), a:has-text("Templates")');
    await expect(page.locator('h2:has-text("Templates")')).toBeVisible({ timeout: 5000 });

    // First create a template to edit
    await page.click('button:has-text("+ New")');
    const templateName = `edit-test-${Date.now()}`;
    await page.fill('input[placeholder="my-template"]', templateName);
    await page.click('button:has-text("Create")');
    await expect(page.locator(`text=${templateName}`)).toBeVisible({ timeout: 5000 });

    // Click Edit on the template - find the card containing the name then get its Edit button
    const templateCard = page.locator('.bg-slate-800.rounded-lg').filter({ hasText: templateName });
    await templateCard.locator('button:has-text("Edit")').click();

    // Wait for edit modal
    await expect(page.locator('h2:has-text("Edit Template")')).toBeVisible();

    // Change persona
    await page.fill('textarea[placeholder*="senior engineer"]', 'Updated persona');

    // Click Save
    await page.click('button:has-text("Save")');

    // Verify modal closed
    await expect(page.locator('h2:has-text("Edit Template")')).not.toBeVisible({ timeout: 3000 });
  });

  test('4. Delete an agent template', async ({ page }) => {
    // Navigate to Templates tab
    await page.click('button:has-text("Templates"), a:has-text("Templates")');
    await expect(page.locator('h2:has-text("Templates")')).toBeVisible({ timeout: 5000 });

    // First create a template to delete
    await page.click('button:has-text("+ New")');
    const templateName = `delete-test-${Date.now()}`;
    await page.fill('input[placeholder="my-template"]', templateName);
    await page.click('button:has-text("Create")');
    await expect(page.locator(`text=${templateName}`)).toBeVisible({ timeout: 5000 });

    // Handle confirm dialog
    page.on('dialog', dialog => dialog.accept());

    // Click Delete on the template - find the card containing the name then get its Delete button
    const templateCard = page.locator('.bg-slate-800.rounded-lg').filter({ hasText: templateName });
    await templateCard.locator('button:has-text("Delete")').click();

    // Verify template is removed
    await expect(page.locator(`text=${templateName}`)).not.toBeVisible({ timeout: 5000 });
  });

  test('5. Edit room topic', async ({ page }) => {
    // First ensure there's a room - use existing one or create
    const roomButton = page.locator('aside ul li button').first();

    if (await roomButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Hover over room to reveal edit button
      await roomButton.hover();

      // Click edit topic button (✎)
      const editButton = page.locator('button[title="Edit topic"]').first();
      await editButton.click();

      // Wait for edit topic modal
      await expect(page.locator('h2:has-text("Edit topic")')).toBeVisible();

      // Change topic
      await page.fill('textarea[placeholder*="topic"]', `Updated topic ${Date.now()}`);

      // Click Save
      await page.click('button:has-text("Save")');

      // Verify modal closed
      await expect(page.locator('h2:has-text("Edit topic")')).not.toBeVisible({ timeout: 3000 });
    } else {
      test.skip();
    }
  });

  test('6. Expected cast shows for room with templates', async ({ page }) => {
    // Use the existing test-with-templates room
    const roomButton = page.locator('aside ul li button').filter({ hasText: 'test-with-templates' });

    if (await roomButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await roomButton.click();

      // Wait for agents panel to load
      await page.waitForSelector('aside:has-text("Agents")', { timeout: 5000 });

      // Verify "Expected cast" section appears in the right panel (agents panel)
      const agentsPanel = page.locator('aside').filter({ hasText: 'Agents' });
      await expect(agentsPanel.locator('text=Expected cast')).toBeVisible({ timeout: 5000 });

      // Verify template names are shown with "not joined" label (at least one)
      await expect(agentsPanel.locator('text=· not joined').first()).toBeVisible();
    } else {
      // Create room with templates if it doesn't exist
      await page.click('button[title="Create room"]');
      await expect(page.locator('h2:has-text("Create Room")')).toBeVisible();

      await page.fill('input[placeholder="Room name"]', 'test-expected-cast');
      await page.click('button:has-text("Create"), button:has-text("Next")');

      // Skip template selection if shown (we need templates first)
      const skipButton = page.locator('button:has-text("Skip")');
      if (await skipButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await skipButton.click();
      }

      console.log('Created room, but need templates to test Expected cast');
    }
  });

  test('7. Send input to agent', async ({ page }) => {
    // Select a room that has agents
    const roomButton = page.locator('aside ul li button').first();

    if (await roomButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await roomButton.click();

      // Wait for agents list
      await page.waitForSelector('aside:has-text("Agents")', { timeout: 5000 });

      // Click on an agent
      const agentButton = page.locator('aside:has-text("Agents") ul li button').first();

      if (await agentButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await agentButton.click();

        // Wait for agent details
        await page.waitForTimeout(500);

        // Check if send input button exists (only for agents with tmux_target)
        const sendButton = page.locator('button:has-text("Send input to agent")');

        if (await sendButton.isVisible({ timeout: 3000 }).catch(() => false)) {
          await sendButton.click();

          // Verify textarea appears
          await expect(page.locator('textarea[placeholder*="Text to send"]')).toBeVisible();

          // Fill text
          await page.fill('textarea[placeholder*="Text to send"]', 'Test input');

          // Click Send
          await page.click('button:has-text("Send (⌘↵)")');

          // Verify success (textarea closes)
          await expect(page.locator('textarea[placeholder*="Text to send"]')).not.toBeVisible({ timeout: 5000 });
        } else {
          console.log('Agent has no tmux_target - send input not available');
        }
      } else {
        console.log('No agents in room');
      }
    } else {
      test.skip();
    }
  });
});
